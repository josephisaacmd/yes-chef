const express = require('express');
const { db } = require('../db');

const router = express.Router();

// GET /api/tags  -> [{ id, name, meal_count }]
router.get('/', (_req, res) => {
  const rows = db.prepare(`
    SELECT t.id, t.name, COUNT(mt.meal_id) AS meal_count
    FROM tags t
    LEFT JOIN meal_tags mt ON mt.tag_id = t.id
    GROUP BY t.id
    ORDER BY t.name COLLATE NOCASE
  `).all();
  res.json(rows);
});

// POST /api/tags { name }
router.post('/', (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const info = db.prepare('INSERT INTO tags (name) VALUES (?)').run(name);
    res.status(201).json({ id: info.lastInsertRowid, name });
  } catch (err) {
    if (String(err).includes('UNIQUE')) return res.status(409).json({ error: 'tag exists' });
    throw err;
  }
});

// PUT /api/tags/:id { name }  -> rename a tag
router.put('/:id', (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const info = db.prepare('UPDATE tags SET name = ? WHERE id = ?').run(name, req.params.id);
    if (!info.changes) return res.status(404).json({ error: 'not found' });
    res.json({ id: Number(req.params.id), name });
  } catch (err) {
    if (String(err).includes('UNIQUE')) return res.status(409).json({ error: 'tag exists' });
    throw err;
  }
});

// DELETE /api/tags/:id
router.delete('/:id', (req, res) => {
  const info = db.prepare('DELETE FROM tags WHERE id = ?').run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

module.exports = router;
