// Smart meal picker.
//
// Each candidate meal is scored on three signals, blended by a single
// `variety` knob (0 = uniform random; 1 = strongly prefer novel / under-eaten):
//
//   recency   — long-time-no-see meals score higher (saturates at 90 days)
//   rarity    — meals eaten less than their fair share score higher
//   novelty   — never-eaten meals get a flat bonus
//
// Weighted-random sampling is used, so picks remain non-deterministic even
// at high variety — the algorithm just biases the dice.

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

/**
 * @param {object} opts
 * @param {string[]} opts.tags         Tag names to AND-filter by (case-insensitive).
 * @param {number}   opts.variety      0..1. 0 = pure random, 1 = max variety.
 * @param {number}   opts.avoidDays    Hard exclude meals eaten within N days (0 disables).
 * @param {number}   opts.limit        How many candidates to return (default 1).
 * @param {number[]} opts.excludeIds   Meal IDs to drop from the candidate pool entirely.
 * @returns {{ picks: object[], fallback: string|null, candidates_considered: number }}
 */
function pickMeals({ tags = [], variety = 0.5, avoidDays = 14, limit = 1, excludeIds = [] } = {}) {
  variety = Math.max(0, Math.min(1, Number(variety) || 0));
  avoidDays = Math.max(0, parseInt(avoidDays, 10) || 0);
  limit = Math.max(1, parseInt(limit, 10) || 1);
  const excludeSet = new Set((excludeIds || []).map(Number).filter(Number.isFinite));

  // ---- pull candidate set with tag filter ----
  let sql = `
    SELECT m.id, m.name, m.notes,
           (SELECT MAX(on_date) FROM entries e WHERE e.meal_id = m.id AND e.status = 'eaten') AS last_eaten,
           (SELECT COUNT(*)     FROM entries e WHERE e.meal_id = m.id AND e.status = 'eaten') AS eaten_count
    FROM meals m
  `;
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
  if (excludeSet.size) meals = meals.filter(m => !excludeSet.has(m.id));
  if (!meals.length) return { picks: [], fallback: null, candidates_considered: 0 };

  // ---- apply avoid-days as a soft filter (fallback if it empties everything) ----
  const today = localTodayISO();
  let candidates = meals;
  let fallback = null;
  if (avoidDays > 0) {
    const filtered = meals.filter(m => !m.last_eaten || diffDays(today, m.last_eaten) >= avoidDays);
    if (filtered.length) candidates = filtered;
    else fallback = 'avoidance window relaxed';
  }

  // ---- score ----
  const totalEaten = meals.reduce((s, m) => s + m.eaten_count, 0) || 1;
  const fairShare  = 1 / meals.length;

  const scored = candidates.map(m => {
    const daysSince = m.last_eaten ? diffDays(today, m.last_eaten) : 365;
    const recency = Math.min(daysSince, 90) / 90;                       // 0..1
    const share   = m.eaten_count / totalEaten;
    const rarity  = 1 / (1 + share / fairShare);                        // 0..1, higher when under-eaten
    const novelty = m.eaten_count === 0 ? 1 : 0;

    const varietyScore = 0.55 * recency + 0.35 * rarity + 0.10 * novelty;
    // Blend: uniform weight 1 at variety=0; emphasised variety score at variety=1.
    // The +0.05 floor keeps every meal pickable even at variety=1.
    const weight = (1 - variety) * 1 + variety * (0.05 + varietyScore);

    return { meal: m, weight, daysSince, eaten_count: m.eaten_count };
  });

  // ---- weighted sampling without replacement ----
  const picks = [];
  const pool = scored.slice();
  while (picks.length < limit && pool.length) {
    const total = pool.reduce((s, x) => s + x.weight, 0);
    let r = Math.random() * total;
    let idx = 0;
    for (; idx < pool.length - 1; idx++) {
      r -= pool[idx].weight;
      if (r <= 0) break;
    }
    const [chosen] = pool.splice(idx, 1);
    picks.push({
      ...chosen.meal,
      _score: chosen.weight,
      _days_since: chosen.daysSince === 365 ? null : chosen.daysSince,
      _eaten_count: chosen.eaten_count,
    });
  }

  return { picks, fallback, candidates_considered: candidates.length };
}

module.exports = { pickMeals, localTodayISO };
