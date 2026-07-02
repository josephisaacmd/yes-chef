// Smart meal picker, v2 — a repeat-consumption model of Christine's appetite.
//
// Rather than one global "avoid the last N days" window, every meal is scored
// on ITS OWN re-eat clock, learned from history:
//
//   dueness   — how close the meal is to its typical re-eat gap. Low right
//               after eating, peaks around the meal's own cadence, then decays
//               gently toward a floor (long-forgotten ≠ forbidden). Meals with
//               too little history inherit their tags' cadence, then the
//               global cadence (hierarchical fallback).
//   kick      — moods are self-exciting: eaten 2+ times recently and still
//               fresh → boost ("she's on a kick"); a kick gone quiet → brief
//               cooldown (satiation).
//   reaction  — 😣 sat_poorly recently → strong suppression; 👍 liked → mild
//               boost. Signals decay after ~45 days.
//   rejection — suggested and passed over in the last week → small penalty.
//   novelty   — never-eaten meals get a moderate constant so they surface
//               without dominating.
//
// scoreMeals() is DETERMINISTIC (same inputs → same scores) so it can be
// backtested against history; pickMeals() adds weighted sampling + the
// variety knob on top. Each scored meal carries a human-readable `_why`.
//
// `eater` scopes the history: 'christine' (default — her stomach drives both
// lunch and the shared dinner) uses entries she ate (christine|both).

const { db } = require('../db');

function localTodayISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function diffDays(aISO, bISO) {
  const a = new Date(aISO + 'T00:00');
  const b = new Date(bISO + 'T00:00');
  return Math.round((a - b) / 86400000);
}

function median(nums) {
  if (!nums.length) return null;
  const s = nums.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ---------------------------------------------------------------------------
// History assembly
// ---------------------------------------------------------------------------

// Entries relevant to the given eater ('christine' → christine|both, etc.).
function eatenHistory(eater) {
  const rows = db.prepare(`
    SELECT meal_id, on_date, eater, reaction
    FROM entries
    WHERE status = 'eaten' AND (eater = ? OR eater = 'both')
    ORDER BY on_date ASC
  `).all(eater === 'both' ? 'both' : eater);
  return rows;
}

// Per-meal digest: distinct eat dates, gaps, last reaction.
function buildDigests(history) {
  const byMeal = new Map();
  for (const r of history) {
    if (!byMeal.has(r.meal_id)) byMeal.set(r.meal_id, { dates: [], reactions: [] });
    const d = byMeal.get(r.meal_id);
    if (d.dates[d.dates.length - 1] !== r.on_date) d.dates.push(r.on_date); // distinct, already sorted
    if (r.reaction) d.reactions.push({ on_date: r.on_date, reaction: r.reaction });
  }
  for (const d of byMeal.values()) {
    d.gaps = [];
    for (let i = 1; i < d.dates.length; i++) d.gaps.push(diffDays(d.dates[i], d.dates[i - 1]));
    d.lastEaten = d.dates[d.dates.length - 1] || null;
    d.lastReaction = d.reactions[d.reactions.length - 1] || null;
  }
  return byMeal;
}

// Meals recently offered-and-not-chosen (passed/rejected in the last 7 days).
function recentlySpurnedMealIds(todayISO_) {
  const rows = db.prepare(`
    SELECT DISTINCT meal_id FROM suggestion_log
    WHERE outcome IN ('passed', 'rejected')
      AND created_at >= datetime(?, '-7 days')
  `).all(todayISO_ + 'T00:00:00');
  return new Set(rows.map(r => r.meal_id));
}

// ---------------------------------------------------------------------------
// Cadence (typical re-eat gap) with hierarchical fallback
// ---------------------------------------------------------------------------

const MIN_GAPS_MEAL = 2;   // ≥2 gaps (3 eats) to trust a meal's own cadence
const MIN_GAPS_TAG  = 3;   // pooled gaps needed to trust a tag cadence
const DEFAULT_GAP   = 10;  // days, when nothing is known at all

function buildCadences(digests, mealTagsById) {
  // Global: all gaps pooled.
  const allGaps = [];
  for (const d of digests.values()) allGaps.push(...d.gaps);
  const globalGap = median(allGaps) || DEFAULT_GAP;

  // Tag-level: gaps pooled across meals sharing the tag.
  const tagGaps = new Map();
  for (const [mealId, d] of digests) {
    for (const tag of (mealTagsById.get(mealId) || [])) {
      if (!tagGaps.has(tag)) tagGaps.set(tag, []);
      tagGaps.get(tag).push(...d.gaps);
    }
  }
  const tagGap = new Map();
  for (const [tag, gaps] of tagGaps) {
    if (gaps.length >= MIN_GAPS_TAG) tagGap.set(tag, median(gaps));
  }

  // Resolve a meal's typical gap + where it came from.
  function typicalGap(mealId) {
    const d = digests.get(mealId);
    if (d && d.gaps.length >= MIN_GAPS_MEAL) return { gap: median(d.gaps), source: 'meal' };
    const tags = mealTagsById.get(mealId) || [];
    const candidates = tags.map(t => tagGap.get(t)).filter(g => g != null);
    if (candidates.length) return { gap: median(candidates), source: 'tags' };
    return { gap: globalGap, source: 'global' };
  }
  return { typicalGap, globalGap };
}

// Due-ness curve: 0 just after eating, 1.0 at the typical gap, decaying to a
// 0.35 floor when long overdue (an old favourite is still worth suggesting).
function dueness(daysSince, gap) {
  if (daysSince <= 0) return 0.05;
  const g = Math.max(1, gap);
  if (daysSince < g) return 0.15 + 0.85 * Math.pow(daysSince / g, 1.5);
  return 0.35 + 0.65 * Math.exp(-(daysSince - g) / (3 * g));
}

// ---------------------------------------------------------------------------
// Deterministic scoring
// ---------------------------------------------------------------------------

/**
 * Score every candidate meal (no randomness).
 * @param {object} opts
 * @param {string[]} opts.tags        AND tag filter.
 * @param {string}   opts.eater       'christine' (default) | 'joseph' | 'both'
 * @param {string}   opts.today       ISO date override (for backtesting).
 * @param {number[]} opts.excludeIds  Meal IDs to drop entirely.
 * @returns {{ scored: object[], globalGap: number }}
 */
function scoreMeals({ tags = [], eater = 'christine', today = null, excludeIds = [] } = {}) {
  const todayISO_ = today || localTodayISO();
  const excludeSet = new Set((excludeIds || []).map(Number).filter(Number.isFinite));

  // Candidate meals (with tag filter).
  let sql = `SELECT m.id, m.name, m.notes FROM meals m`;
  const params = [];
  if (tags.length) {
    sql += `
      JOIN meal_tags mt ON mt.meal_id = m.id
      JOIN tags t       ON t.id = mt.tag_id
      WHERE t.name IN (${tags.map(() => '?').join(',')}) COLLATE NOCASE
      GROUP BY m.id
      HAVING COUNT(DISTINCT t.name) = ?
    `;
    params.push(...tags, tags.length);
  }
  let meals = db.prepare(sql).all(...params);
  meals = meals.filter(m => !excludeSet.has(m.id));
  if (!meals.length) return { scored: [], globalGap: DEFAULT_GAP };

  // All meal→tag names (for cadence fallback).
  const tagRows = db.prepare(`
    SELECT mt.meal_id, t.name FROM meal_tags mt JOIN tags t ON t.id = mt.tag_id
  `).all();
  const mealTagsById = new Map();
  for (const r of tagRows) {
    if (!mealTagsById.has(r.meal_id)) mealTagsById.set(r.meal_id, []);
    mealTagsById.get(r.meal_id).push(r.name.toLowerCase());
  }

  const history = eatenHistory(eater);
  const digests = buildDigests(history);
  const { typicalGap, globalGap } = buildCadences(digests, mealTagsById);
  const spurned = recentlySpurnedMealIds(todayISO_);

  const scored = meals.map(m => {
    const d = digests.get(m.id);
    const why = [];
    let score;
    let daysSince = null;
    let gapInfo = typicalGap(m.id);

    if (!d || !d.lastEaten) {
      // Never eaten (by this eater): moderate constant so new dishes surface.
      score = 0.5;
      why.push('never tried');
    } else {
      daysSince = diffDays(todayISO_, d.lastEaten);
      score = dueness(daysSince, gapInfo.gap);
      const src = gapInfo.source === 'meal' ? '' : ` (${gapInfo.source} est.)`;
      why.push(`typically every ~${Math.round(gapInfo.gap)}d${src}, last eaten ${daysSince}d ago`);

      // Kick / satiation. A kick is UNUSUALLY dense eating — multiple times
      // within a week — not a meal simply keeping its normal weekly cadence.
      const eats7  = d.dates.filter(dt => { const dd = diffDays(todayISO_, dt); return dd >= 0 && dd <= 7; }).length;
      const eats14 = d.dates.filter(dt => { const dd = diffDays(todayISO_, dt); return dd >= 0 && dd <= 14; }).length;
      if (eats7 >= 2 && daysSince <= 3) {
        score *= 1.5;
        why.push('on a kick 🔥');
      } else if (eats14 >= 3 && daysSince > 3) {
        score *= 0.6;
        why.push('recent kick cooling off');
      }

      // Reaction memory (decays after 45 days).
      if (d.lastReaction && diffDays(todayISO_, d.lastReaction.on_date) <= 45) {
        if (d.lastReaction.reaction === 'sat_poorly') { score *= 0.25; why.push('sat poorly recently 😣'); }
        else if (d.lastReaction.reaction === 'liked')  { score *= 1.15; why.push('liked it 👍'); }
      }
    }

    // Recently offered and passed over → small temporary penalty.
    if (spurned.has(m.id)) {
      score *= 0.75;
      why.push('passed over this week');
    }

    score = Math.max(0.01, Math.min(1.5, score));
    return {
      ...m,
      _score: Number(score.toFixed(4)),
      _days_since: daysSince,
      _eaten_count: d ? d.dates.length : 0,
      _typical_gap_days: Math.round(gapInfo.gap),
      _gap_source: gapInfo.source,
      _why: why.join(' · '),
    };
  });

  scored.sort((a, b) => b._score - a._score);
  return { scored, globalGap };
}

// ---------------------------------------------------------------------------
// Sampling wrapper (public API — same shape as v1)
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {string[]} opts.tags
 * @param {number}   opts.variety    0..1: 0 = uniform random, 1 = trust the model.
 * @param {number}   opts.avoidDays  Hard exclude meals eaten within N days (default 1 —
 *                                   the model handles longer horizons via cadence).
 * @param {number}   opts.limit
 * @param {number[]} opts.excludeIds
 * @param {string}   opts.eater
 * @param {string}   opts.today      ISO override for backtesting.
 */
function pickMeals({ tags = [], variety = 0.5, avoidDays = 1, limit = 1, excludeIds = [], eater = 'christine', today = null } = {}) {
  variety = Math.max(0, Math.min(1, Number(variety) || 0));
  avoidDays = Math.max(0, parseInt(avoidDays, 10) || 0);
  limit = Math.max(1, parseInt(limit, 10) || 1);

  const { scored } = scoreMeals({ tags, eater, today, excludeIds });
  if (!scored.length) return { picks: [], fallback: null, candidates_considered: 0 };

  // Hard avoid window (default 1 day: never re-suggest today's/yesterday's meal).
  let candidates = scored;
  let fallback = null;
  if (avoidDays > 0) {
    const filtered = scored.filter(m => m._days_since == null || m._days_since >= avoidDays);
    if (filtered.length) candidates = filtered;
    else fallback = 'avoidance window relaxed';
  }

  // Variety blend, then weighted sampling without replacement.
  const pool = candidates.map(m => ({
    meal: m,
    weight: (1 - variety) * 1 + variety * (0.05 + m._score),
  }));
  const picks = [];
  while (picks.length < limit && pool.length) {
    const total = pool.reduce((s, x) => s + x.weight, 0);
    let r = Math.random() * total;
    let idx = 0;
    for (; idx < pool.length - 1; idx++) {
      r -= pool[idx].weight;
      if (r <= 0) break;
    }
    const [chosen] = pool.splice(idx, 1);
    picks.push(chosen.meal);
  }

  return { picks, fallback, candidates_considered: candidates.length };
}

module.exports = { pickMeals, scoreMeals, localTodayISO };
