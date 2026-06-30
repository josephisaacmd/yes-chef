// Entries = planned or eaten meal occurrences.
// Same shape for both; status = 'planned' | 'eaten'.

const express = require('express');
const { db } = require('../db');

const router = express.Router();

// Known slot labels. Slot is now OPTIONAL — an empty string means "no slot"
// (just something eaten that day). Any number of entries may share a day.
const SLOTS = new Set(['breakfast', 'lunch', 'side', 'dinner', 'snack']);
const STATUSES = new Set(['planned', 'eaten']);
const validSlot = (s) => s === '' || SLOTS.has(s);

function hydrate(rows) {
  if (!rows.length) return rows;
  const ids = rows.map(r => r.meal_id);
  const placeholders = ids.map(() => '?').join(',');
  const meals = db.prepare(`SELECT id, name FROM meals WHERE id IN (${placeholders})`).all(...ids);
  const byId = new Map(meals.map(m => [m.id, m]));
  for (const r of rows) r.meal = byId.get(r.meal_id) || null;
  return rows;
}

// GET /api/entries?from=YYYY-MM-DD&to=YYYY-MM-DD&status=planned|eaten
router.get('/', (req, res) => {
  const { from, to, status } = req.query;
  const where = [];
  const params = [];
  if (from)   { where.push('on_date >= ?'); params.push(from); }
  if (to)     { where.push('on_date <= ?'); params.push(to); }
  if (status) { where.push('status = ?');   params.push(status); }
  const sql = `
    SELECT * FROM entries
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY on_date DESC, slot
  `;
  res.json(hydrate(db.prepare(sql).all(...params)));
});

// POST /api/entries { meal_id, on_date, slot?, status?, notes?, rating? }
router.post('/', (req, res) => {
  const { meal_id, on_date, slot = '', status = 'planned', notes = '', rating = null } = req.body || {};
  if (!meal_id || !on_date) return res.status(400).json({ error: 'meal_id and on_date required' });
  if (!validSlot(slot))     return res.status(400).json({ error: 'bad slot' });
  if (!STATUSES.has(status)) return res.status(400).json({ error: 'bad status' });
  const meal = db.prepare('SELECT id FROM meals WHERE id = ?').get(meal_id);
  if (!meal) return res.status(400).json({ error: 'meal does not exist' });

  const info = db.prepare(`
    INSERT INTO entries (meal_id, on_date, slot, status, notes, rating)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(meal_id, on_date, slot, status, notes, rating);
  const row = db.prepare('SELECT * FROM entries WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(hydrate([row])[0]);
});

// PATCH /api/entries/:id  { status?, slot?, notes?, rating?, on_date?, meal_id? }
router.patch('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM entries WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  const fields = ['meal_id', 'on_date', 'slot', 'status', 'notes', 'rating'];
  const updates = [];
  const params = [];
  for (const f of fields) {
    if (f in (req.body || {})) {
      if (f === 'slot' && !validSlot(req.body.slot)) return res.status(400).json({ error: 'bad slot' });
      if (f === 'status' && !STATUSES.has(req.body.status)) return res.status(400).json({ error: 'bad status' });
      updates.push(`${f} = ?`);
      params.push(req.body[f]);
    }
  }
  if (!updates.length) return res.json(hydrate([row])[0]);
  params.push(row.id);
  db.prepare(`UPDATE entries SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  const updated = db.prepare('SELECT * FROM entries WHERE id = ?').get(row.id);
  res.json(hydrate([updated])[0]);
});

// DELETE /api/entries/:id
router.delete('/:id', (req, res) => {
  const info = db.prepare('DELETE FROM entries WHERE id = ?').run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

module.exports = router;
