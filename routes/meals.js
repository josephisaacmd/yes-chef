// CRUD for meals + tag filtering + "pick a meal" random selector.

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { db, setMealTags, attachTagsToMeals, bulkImportMeals, safeJSON, DATA_DIR } = require('../db');
const { pickMeals } = require('../lib/pick-algorithm');
const comfy = require('../lib/comfyui');

const router = express.Router();

const PHOTO_DIR = path.join(DATA_DIR, 'photos');
fs.mkdirSync(PHOTO_DIR, { recursive: true });

const MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/jpg':  'jpg',
  'image/png':  'png',
  'image/webp': 'webp',
  'image/gif':  'gif',
  'image/heic': 'heic',
  'image/heif': 'heif',
};
const MAX_PHOTO_BYTES = 15 * 1024 * 1024; // 15 MB

// Writes image bytes to the photo dir, verifies the write, and inserts a
// meal_photos row. Returns { id, filename, url }. Throws on disk failure.
function saveMealPhoto(mealId, buf, ext) {
  const filename = `${crypto.randomUUID()}.${ext}`;
  const filePath = path.join(PHOTO_DIR, filename);
  fs.writeFileSync(filePath, buf);
  const stat = fs.statSync(filePath);
  if (stat.size !== buf.length) throw new Error(`size mismatch: wrote ${buf.length}, on-disk ${stat.size}`);

  const maxRow = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM meal_photos WHERE meal_id = ?').get(mealId);
  const sort_order = (maxRow?.m ?? -1) + 1;
  const info = db.prepare('INSERT INTO meal_photos (meal_id, filename, sort_order) VALUES (?, ?, ?)')
                 .run(mealId, filename, sort_order);
  return { id: info.lastInsertRowid, filename, url: `/photos/${filename}` };
}

// Builds the JOIN + WHERE + GROUP HAVING fragment for tag filtering.
// Returns { sql, params } that callers append after `FROM meals m`.
function tagFilterFragment(tags) {
  if (!tags.length) return { sql: '', params: [], group: '' };
  const placeholders = tags.map(() => '?').join(',');
  return {
    sql: `
      JOIN meal_tags mt ON mt.meal_id = m.id
      JOIN tags t       ON t.id = mt.tag_id
      WHERE t.name IN (${placeholders}) COLLATE NOCASE
    `,
    params: tags,
    group: ` GROUP BY m.id HAVING COUNT(DISTINCT t.name) = ${tags.length} `,
  };
}

// GET /api/meals?tag=healthy&tag=quick&q=chicken
// Returns all meals with their tags. Optional filters: ?tag= (repeatable, AND), ?q= name search.
router.get('/', (req, res) => {
  const tags = [].concat(req.query.tag || []).filter(Boolean);
  const q = (req.query.q || '').trim();

  let sql = 'SELECT m.* FROM meals m';
  const params = [];
  const where = [];

  if (tags.length) {
    sql += `
      JOIN meal_tags mt ON mt.meal_id = m.id
      JOIN tags t       ON t.id = mt.tag_id
    `;
    where.push(`t.name IN (${tags.map(() => '?').join(',')}) COLLATE NOCASE`);
    params.push(...tags);
  }
  if (q) {
    where.push('m.name LIKE ?');
    params.push(`%${q}%`);
  }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  if (tags.length) {
    sql += ' GROUP BY m.id HAVING COUNT(DISTINCT t.name) = ?';
    params.push(tags.length);
  }
  sql += ' ORDER BY m.name COLLATE NOCASE';

  const meals = db.prepare(sql).all(...params);
  res.json(attachTagsToMeals(meals));
});

// GET /api/meals/random?tag=healthy&avoid_days=14&variety=0.5
// Returns one meal selected by the scoring algorithm in lib/pick-algorithm.
// `variety` ranges 0..1; 0 = pure random, 1 = strongly prefer novel/under-eaten.
router.get('/random', (req, res) => {
  const tags = [].concat(req.query.tag || []).filter(Boolean);
  const avoid_days = parseInt(req.query.avoid_days ?? '14', 10);
  const variety = parseFloat(req.query.variety ?? '0.5');

  const { picks, fallback } = pickMeals({ tags, variety, avoidDays: avoid_days, limit: 1 });
  if (!picks.length) return res.status(404).json({ error: 'no meals match' });
  attachTagsToMeals(picks);
  const meal = picks[0];
  if (fallback) meal._fallback = fallback;
  res.json(meal);
});

// GET /api/meals/new?tag=healthy
// "Try something new": prefer meals never eaten, then meals not eaten in the
// longest time. Tag filters apply. Random tiebreak among equally-stale candidates.
router.get('/new', (req, res) => {
  const tags = [].concat(req.query.tag || []).filter(Boolean);
  const frag = tagFilterFragment(tags);

  // LEFT JOIN entries so meals with zero history get NULL last_eaten -> rank first.
  const parts = [`SELECT m.*, MAX(e.on_date) AS last_eaten FROM meals m`];
  if (frag.sql) parts.push(frag.sql);
  parts.push(`LEFT JOIN entries e ON e.meal_id = m.id AND e.status = 'eaten'`);
  parts.push(`GROUP BY m.id`);
  if (tags.length) parts.push(`HAVING COUNT(DISTINCT t.name) = ${tags.length}`);
  parts.push(`ORDER BY (last_eaten IS NULL) DESC, last_eaten ASC, RANDOM() LIMIT 1`);
  const sql = parts.join('\n');

  const meal = db.prepare(sql).get(...frag.params);
  if (!meal) return res.status(404).json({ error: 'no meals match' });
  // Hide the join-only column from the JSON response.
  delete meal.last_eaten;
  attachTagsToMeals([meal]);
  res.json(meal);
});

// POST /api/meals/bulk  { meals: [{name, tags?, notes?}], merge_tags?: bool }
// Idempotent bulk import. Existing names get tags merged; brand-new names inserted.
router.post('/bulk', (req, res) => {
  const list = Array.isArray(req.body?.meals) ? req.body.meals : null;
  if (!list) return res.status(400).json({ error: 'meals array required' });
  const summary = bulkImportMeals(list, { mergeTags: req.body.merge_tags !== false });
  res.json(summary);
});

// GET /api/meals/:id
router.get('/:id', (req, res) => {
  const meal = db.prepare('SELECT * FROM meals WHERE id = ?').get(req.params.id);
  if (!meal) return res.status(404).json({ error: 'not found' });
  attachTagsToMeals([meal]);
  res.json(meal);
});

// POST /api/meals  { name, notes?, tags?: [string], nutrition?: object }
router.post('/', (req, res) => {
  const { name, notes = '', tags = [], nutrition = null } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });
  try {
    const info = db.prepare('INSERT INTO meals (name, notes, nutrition_json) VALUES (?, ?, ?)')
      .run(name.trim(), notes, nutrition && typeof nutrition === 'object' ? JSON.stringify(nutrition) : null);
    setMealTags(info.lastInsertRowid, tags);
    const meal = db.prepare('SELECT * FROM meals WHERE id = ?').get(info.lastInsertRowid);
    attachTagsToMeals([meal]);
    res.status(201).json(meal);
  } catch (err) {
    if (String(err).includes('UNIQUE')) return res.status(409).json({ error: 'meal already exists' });
    throw err;
  }
});

// PUT /api/meals/:id  { name?, notes?, tags?, nutrition? }
router.put('/:id', (req, res) => {
  const meal = db.prepare('SELECT * FROM meals WHERE id = ?').get(req.params.id);
  if (!meal) return res.status(404).json({ error: 'not found' });
  const { name, notes, tags, nutrition } = req.body || {};
  const newName  = (name ?? meal.name).trim();
  const newNotes = notes ?? meal.notes;
  let newNutritionJson = meal.nutrition_json;
  if (nutrition !== undefined) {
    newNutritionJson = nutrition && typeof nutrition === 'object' ? JSON.stringify(nutrition) : null;
  }
  try {
    db.prepare(`UPDATE meals SET name = ?, notes = ?, nutrition_json = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(newName, newNotes, newNutritionJson, meal.id);
  } catch (err) {
    if (String(err).includes('UNIQUE')) return res.status(409).json({ error: 'name already in use' });
    throw err;
  }
  if (Array.isArray(tags)) setMealTags(meal.id, tags);
  const updated = db.prepare('SELECT * FROM meals WHERE id = ?').get(meal.id);
  attachTagsToMeals([updated]);
  res.json(updated);
});

// POST /api/meals/:id/photos  { data: 'data:image/...;base64,....' }  or { data, mime }
router.post('/:id/photos', (req, res) => {
  const meal = db.prepare('SELECT id FROM meals WHERE id = ?').get(req.params.id);
  if (!meal) return res.status(404).json({ error: 'meal not found' });

  let { data, mime } = req.body || {};
  if (!data || typeof data !== 'string') return res.status(400).json({ error: 'data required' });

  // Accept either a data URL or raw base64 + explicit mime.
  const m = /^data:([^;]+);base64,(.+)$/.exec(data);
  let b64;
  if (m) { mime = m[1].toLowerCase(); b64 = m[2]; }
  else   { b64 = data; mime = (mime || '').toLowerCase(); }

  const ext = MIME_EXT[mime];
  if (!ext) return res.status(415).json({ error: 'unsupported image type' });

  let buf;
  try { buf = Buffer.from(b64, 'base64'); }
  catch { return res.status(400).json({ error: 'invalid base64' }); }
  if (!buf.length) return res.status(400).json({ error: 'empty image' });
  if (buf.length > MAX_PHOTO_BYTES) return res.status(413).json({ error: 'image too large' });

  let saved;
  try {
    saved = saveMealPhoto(meal.id, buf, ext);
  } catch (err) {
    console.error('[photos] write failed for meal', meal.id, '—', err.message);
    return res.status(500).json({
      error: 'failed to save photo file',
      detail: `${err.code || ''} ${err.message}`.trim(),
    });
  }
  res.status(201).json(saved);
});

// POST /api/meals/:id/generate-image  { prompt? }
// Generates a dish image via the configured ComfyUI server and saves it as a
// meal photo. If `prompt` is omitted, one is built from the meal name + the
// configured prompt template.
router.post('/:id/generate-image', async (req, res) => {
  const meal = db.prepare('SELECT id, name FROM meals WHERE id = ?').get(req.params.id);
  if (!meal) return res.status(404).json({ error: 'meal not found' });
  if (!comfy.isEnabled()) {
    return res.status(503).json({ error: 'ComfyUI is not configured. Set the base URL and workflow in Settings.', info: comfy.info() });
  }

  const prompt = (req.body?.prompt && String(req.body.prompt).trim()) || comfy.buildPrompt(meal.name);
  let result;
  try {
    result = await comfy.generateImage({ prompt });
  } catch (err) {
    console.error('[comfyui] generate failed for meal', meal.id, '—', err.message);
    return res.status(502).json({ error: 'image generation failed', detail: err.message });
  }

  const ext = (result.filename.split('.').pop() || 'png').toLowerCase();
  try {
    const saved = saveMealPhoto(meal.id, result.buffer, ext);
    res.status(201).json({ ...saved, prompt });
  } catch (err) {
    console.error('[comfyui] save failed for meal', meal.id, '—', err.message);
    res.status(500).json({ error: 'failed to save generated image', detail: err.message });
  }
});

// DELETE /api/meals/:id/photos/:photoId
router.delete('/:id/photos/:photoId', (req, res) => {
  const row = db.prepare('SELECT id, filename FROM meal_photos WHERE id = ? AND meal_id = ?')
                .get(req.params.photoId, req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  db.prepare('DELETE FROM meal_photos WHERE id = ?').run(row.id);
  try { fs.unlinkSync(path.join(PHOTO_DIR, row.filename)); } catch {}
  res.json({ ok: true });
});

// DELETE /api/meals/:id
router.delete('/:id', (req, res) => {
  const info = db.prepare('DELETE FROM meals WHERE id = ?').run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

module.exports = router;
