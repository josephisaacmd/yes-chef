// /api/v1/agent/* — endpoints designed for autonomous AI agents
// (Claude Dispatch, Hermes, OpenClaw, etc.) as well as for the web UI itself.
//
// All routes are also reachable with a normal browser session, so the UI
// uses these for the variety picker and history stats panel.

const express = require('express');
const fs = require('fs');
const path = require('path');

const { db, attachTagsToMeals, safeJSON, setMealTags, DATA_DIR } = require('../db');
const { pickMeals, localTodayISO } = require('../lib/pick-algorithm');
const ai = require('../lib/ai-provider');

const router = express.Router();

const PHOTO_DIR = path.join(DATA_DIR, 'photos');

// ---------------------------------------------------------------------------
// GET /api/v1/agent/spec
// Describes what the agent can do. Used for discovery.
// ---------------------------------------------------------------------------
router.get('/spec', (req, res) => {
  res.json({
    name: 'yes-chef agent api',
    version: 1,
    ai: ai.info(),
    endpoints: [
      { method: 'GET',  path: '/api/v1/agent/state',           desc: 'Recent + upcoming entries, summary stats' },
      { method: 'GET',  path: '/api/v1/agent/stats',           desc: 'Eating history statistics' },
      { method: 'GET',  path: '/api/v1/agent/recommendations', desc: 'Top-N meal suggestions (variety-tunable)' },
      { method: 'POST', path: '/api/v1/agent/plan/suggest',     desc: 'Suggest meals to fill date×slot cells (preview, does not write)' },
      { method: 'GET',  path: '/api/v1/agent/notes',           desc: 'List notes/reminders (?unread=1, ?dismissed=0)' },
      { method: 'POST', path: '/api/v1/agent/notes',           desc: 'Push a note/reminder' },
      { method: 'PATCH',path: '/api/v1/agent/notes/:id',       desc: 'Mark note read/dismissed' },
      { method: 'DELETE', path: '/api/v1/agent/notes/:id',     desc: 'Delete a note' },
      { method: 'POST', path: '/api/v1/agent/photos/:photoId/analyze', desc: 'Run AI vision on a meal photo' },
      { method: 'POST', path: '/api/v1/agent/photos/:photoId/apply',   desc: 'Apply analysis output to the meal (tags/nutrition/description)' },
      { method: 'GET',  path: '/api/v1/agent/ai/test',                 desc: 'Probe the configured AI provider; returns reachable model list when possible' },
    ],
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/agent/ai/test
// Lightweight health check: confirms the AI provider URL + auth are reachable
// and returns the upstream-visible model list when the provider exposes one.
// ---------------------------------------------------------------------------
router.get('/ai/test', async (_req, res) => {
  if (!ai.isEnabled()) return res.status(503).json({ ok: false, ai: ai.info(), error: 'AI provider not configured' });
  try {
    const result = await ai.testConnection();
    res.json({ ai: ai.info(), ...result });
  } catch (err) {
    res.status(502).json({ ok: false, ai: ai.info(), error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/agent/state?back=14&forward=7
// Snapshot of recent history + planned upcoming, plus unread agent notes.
// Useful for an agent to compose a "morning briefing" or weekly reminder.
// ---------------------------------------------------------------------------
router.get('/state', (req, res) => {
  const back    = clampInt(req.query.back, 0, 60, 14);
  const forward = clampInt(req.query.forward, 0, 30, 7);
  const today = localTodayISO();
  const past = isoOffset(today, -back);
  const future = isoOffset(today, forward);

  const rows = db.prepare(`
    SELECT e.*, m.name AS meal_name
    FROM entries e
    LEFT JOIN meals m ON m.id = e.meal_id
    WHERE e.on_date BETWEEN ? AND ?
    ORDER BY e.on_date ASC, e.slot ASC
  `).all(past, future);

  // Days in the upcoming window that have NO planned meals — useful "needs planning" signal.
  const upcomingDays = [];
  for (let i = 0; i <= forward; i++) upcomingDays.push(isoOffset(today, i));
  const plannedDays = new Set(rows.filter(r => r.on_date >= today).map(r => r.on_date));
  const unplanned = upcomingDays.filter(d => !plannedDays.has(d));

  const notes = db.prepare(`
    SELECT * FROM agent_notes WHERE dismissed = 0 ORDER BY created_at DESC LIMIT 50
  `).all();

  res.json({
    today,
    window: { from: past, to: future },
    entries: rows,
    unplanned_upcoming: unplanned,
    notes,
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/agent/stats
// Eating-pattern statistics for the history view + agent reasoning.
// ---------------------------------------------------------------------------
router.get('/stats', (req, res) => {
  const days = clampInt(req.query.days, 7, 3650, 365);
  const today = localTodayISO();
  const since = isoOffset(today, -days);

  const total = db.prepare(`SELECT COUNT(*) AS n FROM entries WHERE status='eaten' AND on_date >= ?`).get(since).n;

  const perMeal = db.prepare(`
    SELECT m.id, m.name, COUNT(*) AS count, MAX(e.on_date) AS last_eaten
    FROM entries e
    JOIN meals m ON m.id = e.meal_id
    WHERE e.status='eaten' AND e.on_date >= ?
    GROUP BY m.id
    ORDER BY count DESC, last_eaten DESC
  `).all(since);

  const uniqueMeals = perMeal.length;

  const bySlot = db.prepare(`
    SELECT slot, COUNT(*) AS count FROM entries
    WHERE status='eaten' AND on_date >= ?
    GROUP BY slot
  `).all(since);

  const byTag = db.prepare(`
    SELECT t.name AS tag, COUNT(*) AS count
    FROM entries e
    JOIN meal_tags mt ON mt.meal_id = e.meal_id
    JOIN tags t ON t.id = mt.tag_id
    WHERE e.status='eaten' AND e.on_date >= ?
    GROUP BY t.id
    ORDER BY count DESC
  `).all(since);

  const byMonth = db.prepare(`
    SELECT substr(on_date,1,7) AS month, COUNT(*) AS count
    FROM entries
    WHERE status='eaten' AND on_date >= ?
    GROUP BY month
    ORDER BY month
  `).all(since);

  // Shannon-entropy-based variety index, normalised to 0..1.
  // 1 means every meal eaten equally often; 0 means a single meal dominates.
  let variety_index = 0;
  if (perMeal.length > 1 && total > 0) {
    let H = 0;
    for (const m of perMeal) {
      const p = m.count / total;
      if (p > 0) H -= p * Math.log(p);
    }
    variety_index = H / Math.log(perMeal.length);
  }

  // Current "ate-something-on-this-day" streak ending today.
  let streak = 0;
  for (let i = 0; i < 365; i++) {
    const d = isoOffset(today, -i);
    const has = db.prepare(`SELECT 1 FROM entries WHERE status='eaten' AND on_date = ? LIMIT 1`).get(d);
    if (!has) break;
    streak += 1;
  }

  res.json({
    window: { from: since, to: today, days },
    total_eaten: total,
    unique_meals: uniqueMeals,
    variety_index: Number(variety_index.toFixed(3)),
    streak_days: streak,
    top_meals: perMeal.slice(0, 10),
    by_slot: bySlot,
    by_tag: byTag.slice(0, 20),
    by_month: byMonth,
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/agent/recommendations?variety=0.5&n=5&tag=...&avoid_days=14
// Top-N meal suggestions for the agent or the Pick view.
// ---------------------------------------------------------------------------
router.get('/recommendations', (req, res) => {
  const tags = [].concat(req.query.tag || []).filter(Boolean);
  const variety = parseFloat(req.query.variety ?? '0.5');
  const avoid_days = parseInt(req.query.avoid_days ?? '14', 10);
  const n = clampInt(req.query.n, 1, 25, 5);

  const result = pickMeals({ tags, variety, avoidDays: avoid_days, limit: n });
  if (!result.picks.length) return res.status(404).json({ error: 'no meals match' });
  attachTagsToMeals(result.picks);
  res.json({
    variety, avoid_days, tags,
    candidates_considered: result.candidates_considered,
    fallback: result.fallback,
    picks: result.picks,
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/agent/plan/suggest
// Body: {
//   dates: ["YYYY-MM-DD", ...],            // required
//   slots: ["breakfast"|"lunch"|"dinner"|"side"|"snack", ...],   // required
//   tags?: string[],
//   variety?: 0..1,
//   avoid_days?: number,
//   skip_filled?: boolean (default true)   // skip cells that already have entries
//   exclude_meal_ids?: number[]
// }
// Returns: { suggestions: [{on_date, slot, meal}], fills, requested, fallback }
//
// Pure preview — does NOT write anything. The client confirms one at a time
// (or batched) by POSTing each as a regular planned entry.
// ---------------------------------------------------------------------------
const VALID_SLOTS = new Set(['breakfast', 'lunch', 'side', 'dinner', 'snack']);
router.post('/plan/suggest', (req, res) => {
  const b = req.body || {};
  const dates = Array.isArray(b.dates) ? b.dates.map(String).filter(s => /^\d{4}-\d{2}-\d{2}$/.test(s)) : [];
  const slots = Array.isArray(b.slots) ? b.slots.filter(s => VALID_SLOTS.has(s)) : [];
  if (!dates.length) return res.status(400).json({ error: 'dates[] required (YYYY-MM-DD)' });
  if (!slots.length) return res.status(400).json({ error: 'slots[] required' });

  const tags        = Array.isArray(b.tags) ? b.tags : [];
  const variety     = parseFloat(b.variety ?? 0.5);
  const avoid_days  = parseInt(b.avoid_days ?? 14, 10);
  const skip_filled = b.skip_filled !== false;
  const excludeIds  = new Set((Array.isArray(b.exclude_meal_ids) ? b.exclude_meal_ids : []).map(Number).filter(Number.isFinite));

  // Find filled cells + accumulate already-planned meals (so we don't suggest dups).
  const placeholders = dates.map(() => '?').join(',');
  const existingRows = db.prepare(
    `SELECT on_date, slot, meal_id FROM entries WHERE on_date IN (${placeholders})`
  ).all(...dates);
  const filledKeys = new Set();
  for (const r of existingRows) {
    filledKeys.add(`${r.on_date}|${r.slot}`);
    excludeIds.add(r.meal_id);
  }

  // Build the list of empty cells we need to fill.
  const cells = [];
  for (const d of dates) for (const s of slots) {
    const key = `${d}|${s}`;
    if (!skip_filled || !filledKeys.has(key)) cells.push({ on_date: d, slot: s });
  }
  if (!cells.length) {
    return res.json({ suggestions: [], fills: 0, requested: 0, note: 'all selected cells are already filled' });
  }

  const result = pickMeals({
    tags, variety,
    avoidDays: avoid_days,
    limit: cells.length,
    excludeIds: Array.from(excludeIds),
  });
  if (!result.picks.length) {
    return res.status(404).json({ error: 'no meals match the filters (after exclusions)' });
  }

  attachTagsToMeals(result.picks);

  // Pair meals → cells. If there are fewer meals than cells (small library),
  // we just fill what we can.
  const suggestions = cells.slice(0, result.picks.length).map((c, i) => ({
    on_date: c.on_date,
    slot:    c.slot,
    meal:    result.picks[i],
  }));

  res.json({
    suggestions,
    fills:     suggestions.length,
    requested: cells.length,
    fallback:  result.fallback,
    variety, avoid_days, tags,
  });
});

// ---------------------------------------------------------------------------
// Notes / reminders.
// ---------------------------------------------------------------------------
router.get('/notes', (req, res) => {
  const where = [];
  const params = [];
  if ('unread' in req.query)    { where.push('read = ?');      params.push(req.query.unread === '0' ? 1 : 0); }
  if ('dismissed' in req.query) { where.push('dismissed = ?'); params.push(req.query.dismissed === '1' ? 1 : 0); }
  else                          { where.push('dismissed = 0'); }
  const sql = `SELECT * FROM agent_notes ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT 100`;
  res.json(db.prepare(sql).all(...params));
});

router.post('/notes', (req, res) => {
  const { kind = 'info', text, meta, due_date } = req.body || {};
  if (!text || !String(text).trim()) return res.status(400).json({ error: 'text required' });
  const KINDS = new Set(['info', 'reminder', 'recommendation', 'warning']);
  const k = KINDS.has(kind) ? kind : 'info';
  const source = req.auth?.kind === 'agent' ? `agent:${req.auth.token_prefix}` : 'user';
  const info = db.prepare(`
    INSERT INTO agent_notes (kind, text, meta_json, due_date, source)
    VALUES (?, ?, ?, ?, ?)
  `).run(k, String(text).trim(), meta ? JSON.stringify(meta) : null, due_date || null, source);
  const row = db.prepare('SELECT * FROM agent_notes WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(row);
});

router.patch('/notes/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM agent_notes WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  const sets = [];
  const params = [];
  for (const f of ['read', 'dismissed']) {
    if (f in (req.body || {})) { sets.push(`${f} = ?`); params.push(req.body[f] ? 1 : 0); }
  }
  if (!sets.length) return res.json(row);
  params.push(row.id);
  db.prepare(`UPDATE agent_notes SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  res.json(db.prepare('SELECT * FROM agent_notes WHERE id = ?').get(row.id));
});

router.delete('/notes/:id', (req, res) => {
  const info = db.prepare('DELETE FROM agent_notes WHERE id = ?').run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Photo analysis. The photo must already exist on a meal; we read the file
// from disk and hand the bytes to the configured AI provider.
// ---------------------------------------------------------------------------
router.post('/photos/:photoId/analyze', async (req, res) => {
  if (!ai.isEnabled()) return res.status(503).json({ error: 'AI provider not configured', ai: ai.info() });
  const photo = db.prepare('SELECT * FROM meal_photos WHERE id = ?').get(req.params.photoId);
  if (!photo) return res.status(404).json({ error: 'photo not found' });

  const filePath = path.join(PHOTO_DIR, photo.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'photo file missing' });

  const buffer = fs.readFileSync(filePath);
  const mime = mimeFromName(photo.filename);

  try {
    const result = await ai.analyzePhoto({ buffer, mime });
    db.prepare(`UPDATE meal_photos SET analysis_json = ?, analyzed_at = datetime('now') WHERE id = ?`)
      .run(JSON.stringify(result), photo.id);
    res.json({ photo_id: photo.id, meal_id: photo.meal_id, analysis: result, ai: ai.info() });
  } catch (err) {
    console.error('[ai] analyze failed:', err.message);
    res.status(502).json({ error: 'AI analysis failed', detail: err.message });
  }
});

// Apply the most recent analysis to the parent meal record.
// Body: { tags?: true, nutrition?: true, description?: true }
router.post('/photos/:photoId/apply', (req, res) => {
  const photo = db.prepare('SELECT * FROM meal_photos WHERE id = ?').get(req.params.photoId);
  if (!photo) return res.status(404).json({ error: 'photo not found' });
  const analysis = photo.analysis_json ? safeJSON(photo.analysis_json) : null;
  if (!analysis) return res.status(400).json({ error: 'no analysis to apply — run analyze first' });

  const meal = db.prepare('SELECT * FROM meals WHERE id = ?').get(photo.meal_id);
  if (!meal) return res.status(404).json({ error: 'meal not found' });

  const want = req.body || {};
  const changes = {};

  if (want.tags) {
    const incoming = [].concat(analysis.tags || [], analysis.cuisine ? [analysis.cuisine] : []);
    const existing = db.prepare(`
      SELECT t.name FROM tags t JOIN meal_tags mt ON mt.tag_id = t.id WHERE mt.meal_id = ?
    `).all(meal.id).map(r => r.name);
    const merged = Array.from(new Set([...existing, ...incoming.map(s => String(s).trim()).filter(Boolean)]));
    setMealTags(meal.id, merged);
    changes.tags = merged;
  }

  if (want.nutrition && analysis.nutrition) {
    const existing = meal.nutrition_json ? safeJSON(meal.nutrition_json) : null;
    // Merge: incoming values overwrite when non-null.
    const merged = { ...(existing || {}) };
    for (const [k, v] of Object.entries(analysis.nutrition)) if (v != null) merged[k] = v;
    if (analysis.portion) merged.portion = analysis.portion;
    db.prepare(`UPDATE meals SET nutrition_json = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(JSON.stringify(merged), meal.id);
    changes.nutrition = merged;
  }

  if (want.description && analysis.description && !meal.notes) {
    db.prepare(`UPDATE meals SET notes = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(analysis.description, meal.id);
    changes.notes = analysis.description;
  }

  res.json({ ok: true, meal_id: meal.id, applied: changes });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function clampInt(v, lo, hi, def) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, n));
}
function isoOffset(iso, days) {
  const d = new Date(iso + 'T00:00');
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function mimeFromName(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  return {
    jpg: 'image/jpeg', jpeg: 'image/jpeg',
    png: 'image/png',  webp: 'image/webp',
    gif: 'image/gif',  heic: 'image/heic', heif: 'image/heif',
  }[ext] || 'application/octet-stream';
}

module.exports = router;
