// Tiny SQLite layer. Uses better-sqlite3 for synchronous, fast queries.
// One file = one database. Lives under DATA_DIR so it survives container restarts.

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const dbPath = path.join(DATA_DIR, 'web-menu.sqlite');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// --- Schema -------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS meals (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    notes       TEXT    DEFAULT '',
    created_at  TEXT    DEFAULT (datetime('now')),
    updated_at  TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tags (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    name  TEXT    NOT NULL UNIQUE COLLATE NOCASE
  );

  CREATE TABLE IF NOT EXISTS meal_tags (
    meal_id INTEGER NOT NULL REFERENCES meals(id) ON DELETE CASCADE,
    tag_id  INTEGER NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
    PRIMARY KEY (meal_id, tag_id)
  );

  -- One row per planned-or-eaten meal occurrence.
  -- status = 'planned' or 'eaten'. Flip a planned entry to eaten when you've had it.
  CREATE TABLE IF NOT EXISTS entries (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    meal_id    INTEGER NOT NULL REFERENCES meals(id) ON DELETE CASCADE,
    on_date    TEXT    NOT NULL,             -- 'YYYY-MM-DD'
    slot       TEXT    NOT NULL DEFAULT 'dinner',  -- breakfast|lunch|dinner|snack
    status     TEXT    NOT NULL DEFAULT 'planned', -- planned|eaten
    rating     INTEGER,                       -- optional 1-5
    notes      TEXT    DEFAULT '',
    created_at TEXT    DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_entries_date   ON entries(on_date);
  CREATE INDEX IF NOT EXISTS idx_entries_status ON entries(status);

  CREATE TABLE IF NOT EXISTS meal_photos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    meal_id     INTEGER NOT NULL REFERENCES meals(id) ON DELETE CASCADE,
    filename    TEXT    NOT NULL,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_meal_photos_meal ON meal_photos(meal_id);
`);

// Seed a few common tags on first run so the UI isn't empty.
const tagCount = db.prepare('SELECT COUNT(*) AS n FROM tags').get().n;
if (tagCount === 0) {
  const seed = db.prepare('INSERT INTO tags (name) VALUES (?)');
  ['eat out', 'home cook', 'healthy', 'unhealthy', 'quick', 'weekend'].forEach(t => seed.run(t));
}

// --- Helpers ------------------------------------------------------------

function getOrCreateTag(name) {
  const clean = String(name).trim();
  if (!clean) return null;
  const existing = db.prepare('SELECT id FROM tags WHERE name = ? COLLATE NOCASE').get(clean);
  if (existing) return existing.id;
  return db.prepare('INSERT INTO tags (name) VALUES (?)').run(clean).lastInsertRowid;
}

function tagsForMeal(mealId) {
  return db.prepare(`
    SELECT t.id, t.name
    FROM tags t
    JOIN meal_tags mt ON mt.tag_id = t.id
    WHERE mt.meal_id = ?
    ORDER BY t.name
  `).all(mealId);
}

function attachTagsToMeals(meals) {
  if (!meals.length) return meals;
  const ids = meals.map(m => m.id);
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT mt.meal_id, t.id, t.name
    FROM meal_tags mt
    JOIN tags t ON t.id = mt.tag_id
    WHERE mt.meal_id IN (${placeholders})
    ORDER BY t.name
  `).all(...ids);
  const byMeal = new Map();
  for (const r of rows) {
    if (!byMeal.has(r.meal_id)) byMeal.set(r.meal_id, []);
    byMeal.get(r.meal_id).push({ id: r.id, name: r.name });
  }
  for (const m of meals) m.tags = byMeal.get(m.id) || [];
  attachPhotosToMeals(meals);
  return meals;
}

function attachPhotosToMeals(meals) {
  if (!meals.length) return meals;
  const ids = meals.map(m => m.id);
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT id, meal_id, filename, sort_order
    FROM meal_photos
    WHERE meal_id IN (${placeholders})
    ORDER BY sort_order ASC, id ASC
  `).all(...ids);
  const byMeal = new Map();
  for (const r of rows) {
    if (!byMeal.has(r.meal_id)) byMeal.set(r.meal_id, []);
    byMeal.get(r.meal_id).push({ id: r.id, filename: r.filename, url: `/photos/${r.filename}` });
  }
  for (const m of meals) m.photos = byMeal.get(m.id) || [];
  return meals;
}

function setMealTags(mealId, tagNames) {
  const del = db.prepare('DELETE FROM meal_tags WHERE meal_id = ?');
  const ins = db.prepare('INSERT OR IGNORE INTO meal_tags (meal_id, tag_id) VALUES (?, ?)');
  const tx = db.transaction((names) => {
    del.run(mealId);
    for (const name of names) {
      const tagId = getOrCreateTag(name);
      if (tagId) ins.run(mealId, tagId);
    }
  });
  tx(tagNames || []);
}

// Bulk-import meals. Idempotent: existing names (case-insensitive) are kept,
// with tags merged (union) and notes only filled in if previously empty.
// `rows` = [{ name, tags: [string]|string, notes? }]
// Tag strings may use `,` `;` or `|` as separators.
//
// Returns { created, updated, skipped, errors: [{ row, error }] }.
function bulkImportMeals(rows, { mergeTags = true } = {}) {
  function normalizeTags(t) {
    if (Array.isArray(t)) return t.map(s => String(s).trim()).filter(Boolean);
    if (typeof t === 'string') return t.split(/[;,|]/).map(s => s.trim()).filter(Boolean);
    return [];
  }

  const findByName = db.prepare('SELECT id, notes FROM meals WHERE name = ? COLLATE NOCASE');
  const insertMeal = db.prepare('INSERT INTO meals (name, notes) VALUES (?, ?)');
  const updateNotes = db.prepare(`UPDATE meals SET notes = ?, updated_at = datetime('now') WHERE id = ?`);
  const addTag      = db.prepare('INSERT OR IGNORE INTO meal_tags (meal_id, tag_id) VALUES (?, ?)');

  const tx = db.transaction((items) => {
    const summary = { created: 0, updated: 0, skipped: 0, errors: [] };
    for (let i = 0; i < items.length; i++) {
      const item = items[i] || {};
      const name = (item.name || '').toString().trim();
      if (!name) { summary.skipped++; continue; }
      const tags = normalizeTags(item.tags);
      const notes = (item.notes || '').toString().trim();
      try {
        const existing = findByName.get(name);
        if (existing) {
          if (notes && !existing.notes) updateNotes.run(notes, existing.id);
          if (tags.length) {
            if (mergeTags) {
              for (const t of tags) {
                const tid = getOrCreateTag(t);
                if (tid) addTag.run(existing.id, tid);
              }
            } else {
              setMealTags(existing.id, tags);
            }
          }
          summary.updated++;
        } else {
          const info = insertMeal.run(name, notes);
          setMealTags(info.lastInsertRowid, tags);
          summary.created++;
        }
      } catch (err) {
        summary.errors.push({ row: i + 1, name, error: String(err.message || err) });
      }
    }
    return summary;
  });
  return tx(rows);
}

module.exports = {
  db,
  getOrCreateTag,
  tagsForMeal,
  attachTagsToMeals,
  attachPhotosToMeals,
  bulkImportMeals,
  setMealTags,
  DATA_DIR,
};
