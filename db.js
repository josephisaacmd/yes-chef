// Tiny SQLite layer. Uses better-sqlite3 for synchronous, fast queries.
// One file = one database. Lives under DATA_DIR so it survives container restarts.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const dbPath = path.join(DATA_DIR, 'yes-chef.sqlite');
// One-time migration from the pre-rename filename. Safe to leave in place forever.
const legacyDbPath = path.join(DATA_DIR, 'web-menu.sqlite');
if (!fs.existsSync(dbPath) && fs.existsSync(legacyDbPath)) {
  fs.renameSync(legacyDbPath, dbPath);
  // Also move the WAL/SHM sidecars if present.
  for (const ext of ['-wal', '-shm']) {
    const src = legacyDbPath + ext, dst = dbPath + ext;
    if (fs.existsSync(src)) fs.renameSync(src, dst);
  }
  console.log(`[migrate] renamed ${legacyDbPath} → ${dbPath}`);
}
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
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    meal_id       INTEGER NOT NULL REFERENCES meals(id) ON DELETE CASCADE,
    filename      TEXT    NOT NULL,
    sort_order    INTEGER NOT NULL DEFAULT 0,
    analysis_json TEXT,          -- JSON output from the AI vision provider (nullable)
    analyzed_at   TEXT,          -- timestamp of last analysis
    created_at    TEXT    DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_meal_photos_meal ON meal_photos(meal_id);

  -- Notes / reminders an external agent can push to the user, or the user can add manually.
  CREATE TABLE IF NOT EXISTS agent_notes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    kind        TEXT    NOT NULL DEFAULT 'info',   -- info | reminder | recommendation | warning
    text        TEXT    NOT NULL,
    meta_json   TEXT,                              -- arbitrary structured payload
    due_date    TEXT,                              -- optional YYYY-MM-DD
    source      TEXT    DEFAULT 'user',            -- 'agent:<name>' or 'user'
    read        INTEGER NOT NULL DEFAULT 0,
    dismissed   INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_agent_notes_state ON agent_notes(dismissed, read, created_at);

  -- Named AI provider configurations. Multiple can exist; exactly one is_active=1.
  -- Lets users add/swap models from the UI without touching env vars or restarting.
  CREATE TABLE IF NOT EXISTS ai_configs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    label       TEXT    NOT NULL,                -- user-facing name e.g. "Claude 3.5 Sonnet"
    provider    TEXT    NOT NULL,                -- ollama | openai | openai-compatible | openrouter | anthropic
    model       TEXT    DEFAULT '',
    api_key     TEXT    DEFAULT '',              -- stored as-is; sent only to its provider
    base_url    TEXT    DEFAULT '',              -- blank = provider default
    is_active   INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    DEFAULT (datetime('now')),
    updated_at  TEXT    DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_ai_configs_active ON ai_configs(is_active);

  -- Agent API tokens, manageable from the UI. The raw token is shown to the
  -- user exactly once at creation; only a SHA-256 hash + short prefix is stored.
  CREATE TABLE IF NOT EXISTS agent_tokens (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    label        TEXT    NOT NULL,
    token_hash   TEXT    NOT NULL UNIQUE,
    token_prefix TEXT    NOT NULL,             -- first 6 chars, for display
    created_at   TEXT    DEFAULT (datetime('now')),
    last_used_at TEXT
  );

  -- Generic key/value store for app-level settings (e.g. ComfyUI image-gen
  -- config). Values are JSON strings.
  CREATE TABLE IF NOT EXISTS app_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  -- Ground truth for the predictive model: every batch of suggestions that was
  -- actually shown, and what happened to each one. One row per offered meal.
  -- outcome: 'offered' (no feedback yet) | 'chosen' | 'passed' (another meal in
  -- the batch was chosen) | 'rejected' (the whole batch was turned down).
  CREATE TABLE IF NOT EXISTS suggestion_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id     TEXT    NOT NULL,
    meal_id      INTEGER NOT NULL REFERENCES meals(id) ON DELETE CASCADE,
    rank         INTEGER NOT NULL DEFAULT 0,
    context_json TEXT,                              -- {slot?, date?, eater?, tags?, variety?, avoid_days?}
    outcome      TEXT    NOT NULL DEFAULT 'offered',
    created_at   TEXT    DEFAULT (datetime('now')),
    resolved_at  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_suggestion_log_batch ON suggestion_log(batch_id);
  CREATE INDEX IF NOT EXISTS idx_suggestion_log_meal  ON suggestion_log(meal_id, outcome);
`);

// One-off migrations for columns added after the original schema. better-sqlite3
// has no IF NOT EXISTS for ALTER TABLE, so probe with PRAGMA first.
function addColumnIfMissing(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
addColumnIfMissing('meal_photos', 'analysis_json', 'analysis_json TEXT');
addColumnIfMissing('meal_photos', 'analyzed_at',   'analyzed_at TEXT');
addColumnIfMissing('meals',       'nutrition_json','nutrition_json TEXT');
// Who ate this entry. The household is two people; the predictive model needs
// per-person histories because breakfast/lunch are eaten separately.
addColumnIfMissing('entries', 'eater', "eater TEXT NOT NULL DEFAULT 'both'");
// One-tap outcome on an eaten entry: 'liked' | 'sat_poorly' (sensitive-stomach
// signal the scorer will learn from). NULL = no reaction recorded.
addColumnIfMissing('entries', 'reaction', 'reaction TEXT');

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
    SELECT id, meal_id, filename, sort_order, analysis_json, analyzed_at
    FROM meal_photos
    WHERE meal_id IN (${placeholders})
    ORDER BY sort_order ASC, id ASC
  `).all(...ids);
  const byMeal = new Map();
  for (const r of rows) {
    if (!byMeal.has(r.meal_id)) byMeal.set(r.meal_id, []);
    byMeal.get(r.meal_id).push({
      id: r.id,
      filename: r.filename,
      url: `/photos/${r.filename}`,
      analyzed_at: r.analyzed_at || null,
      analysis: r.analysis_json ? safeJSON(r.analysis_json) : null,
    });
  }
  for (const m of meals) {
    m.photos = byMeal.get(m.id) || [];
    m.nutrition = m.nutrition_json ? safeJSON(m.nutrition_json) : null;
  }
  return meals;
}

function safeJSON(s) { try { return JSON.parse(s); } catch { return null; } }

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

// --- AI config helpers --------------------------------------------------

const VALID_AI_PROVIDERS = ['ollama', 'openai', 'openai-compatible', 'openrouter', 'anthropic'];

function listAiConfigs({ includeSecrets = false } = {}) {
  const rows = db.prepare('SELECT * FROM ai_configs ORDER BY id ASC').all();
  return rows.map(r => ({
    id: r.id,
    label: r.label,
    provider: r.provider,
    model: r.model || '',
    base_url: r.base_url || '',
    api_key:  includeSecrets ? (r.api_key || '') : (r.api_key ? maskKey(r.api_key) : ''),
    has_api_key: !!r.api_key,
    is_active: !!r.is_active,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));
}
function maskKey(k) {
  if (!k) return '';
  if (k.length <= 8) return '••••';
  return k.slice(0, 4) + '…' + k.slice(-4);
}
function getActiveAiConfig() {
  const row = db.prepare('SELECT * FROM ai_configs WHERE is_active = 1 LIMIT 1').get();
  return row || null;
}
function getAiConfigById(id) {
  return db.prepare('SELECT * FROM ai_configs WHERE id = ?').get(id) || null;
}
function createAiConfig({ label, provider, model = '', api_key = '', base_url = '', activate = false }) {
  if (!label || !label.trim()) throw new Error('label is required');
  if (!VALID_AI_PROVIDERS.includes(provider)) throw new Error(`provider must be one of: ${VALID_AI_PROVIDERS.join(', ')}`);
  const info = db.prepare(
    'INSERT INTO ai_configs (label, provider, model, api_key, base_url, is_active) VALUES (?, ?, ?, ?, ?, 0)'
  ).run(label.trim(), provider, model || '', api_key || '', base_url || '');
  if (activate) activateAiConfig(info.lastInsertRowid);
  return getAiConfigById(info.lastInsertRowid);
}
function updateAiConfig(id, patch) {
  const cur = getAiConfigById(id);
  if (!cur) throw new Error('config not found');
  const next = {
    label:    patch.label    ?? cur.label,
    provider: patch.provider ?? cur.provider,
    model:    patch.model    ?? cur.model,
    base_url: patch.base_url ?? cur.base_url,
    api_key:  patch.api_key  ?? cur.api_key,
  };
  if (!VALID_AI_PROVIDERS.includes(next.provider)) throw new Error(`provider must be one of: ${VALID_AI_PROVIDERS.join(', ')}`);
  db.prepare(
    `UPDATE ai_configs SET label=?, provider=?, model=?, base_url=?, api_key=?,
     updated_at=datetime('now') WHERE id=?`
  ).run(next.label, next.provider, next.model, next.base_url, next.api_key, id);
  return getAiConfigById(id);
}
function deleteAiConfig(id) {
  const cur = getAiConfigById(id);
  if (!cur) return false;
  db.prepare('DELETE FROM ai_configs WHERE id = ?').run(id);
  // If we just deleted the active one, promote the lowest-id remaining row.
  if (cur.is_active) {
    const next = db.prepare('SELECT id FROM ai_configs ORDER BY id ASC LIMIT 1').get();
    if (next) activateAiConfig(next.id);
  }
  return true;
}
const activateAiConfig = db.transaction((id) => {
  const cur = getAiConfigById(id);
  if (!cur) throw new Error('config not found');
  db.prepare('UPDATE ai_configs SET is_active = 0').run();
  db.prepare('UPDATE ai_configs SET is_active = 1, updated_at = datetime(\'now\') WHERE id = ?').run(id);
  return getAiConfigById(id);
});

// On first boot, if no AI configs exist but env vars are set, seed one from
// the env. Keeps backward compatibility with the previous env-only model.
(function seedAiFromEnv() {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM ai_configs').get().n;
  if (existing > 0) return;
  const provider = (process.env.AI_PROVIDER || '').toLowerCase().trim();
  if (!provider || provider === 'none' || !VALID_AI_PROVIDERS.includes(provider)) return;
  const label = `${provider} (from env)`;
  const created = createAiConfig({
    label,
    provider,
    model:    (process.env.AI_MODEL    || '').trim(),
    api_key:  (process.env.AI_API_KEY  || '').trim(),
    base_url: (process.env.AI_BASE_URL || '').trim(),
    activate: true,
  });
  console.log(`[ai] seeded initial config from env: #${created.id} ${created.label}`);
})();

// --- Agent token helpers ------------------------------------------------

function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw), 'utf8').digest('hex');
}

function listAgentTokens() {
  return db.prepare('SELECT id, label, token_prefix, created_at, last_used_at FROM agent_tokens ORDER BY id ASC')
    .all()
    .map(r => ({
      id: r.id,
      label: r.label,
      token_prefix: r.token_prefix,
      created_at: r.created_at,
      last_used_at: r.last_used_at || null,
    }));
}

// Creates a token, returns the RAW token exactly once. Caller must surface it
// immediately — it cannot be retrieved later (only the hash is stored).
function createAgentToken({ label } = {}) {
  if (!label || !label.trim()) throw new Error('label is required');
  const raw = crypto.randomBytes(32).toString('hex');   // 64 hex chars
  const token_hash = hashToken(raw);
  const token_prefix = raw.slice(0, 6);
  const info = db.prepare(
    'INSERT INTO agent_tokens (label, token_hash, token_prefix) VALUES (?, ?, ?)'
  ).run(label.trim(), token_hash, token_prefix);
  return { id: info.lastInsertRowid, label: label.trim(), token: raw, token_prefix };
}

function deleteAgentToken(id) {
  const info = db.prepare('DELETE FROM agent_tokens WHERE id = ?').run(id);
  return info.changes > 0;
}

// Used by the auth middleware. Returns the matching row (and bumps
// last_used_at) or null. Constant-ish: a single indexed hash lookup.
function verifyAgentToken(raw) {
  if (!raw) return null;
  const row = db.prepare('SELECT id, label, token_prefix FROM agent_tokens WHERE token_hash = ?')
    .get(hashToken(raw));
  if (!row) return null;
  db.prepare("UPDATE agent_tokens SET last_used_at = datetime('now') WHERE id = ?").run(row.id);
  return row;
}

function agentTokenCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM agent_tokens').get().n;
}

// --- Eaters & suggestion log ---------------------------------------------

// The two-person household. Slot-aware defaults: Christine's lunch is packed
// (and breakfast is hers — Joseph skips it); dinner is shared.
const EATERS = ['joseph', 'christine', 'both'];
function defaultEaterForSlot(slot) {
  if (slot === 'lunch' || slot === 'breakfast' || slot === 'side') return 'christine';
  return 'both';
}

const VALID_REACTIONS = ['liked', 'sat_poorly'];

// Record a batch of offered suggestions. `picks` = [{meal_id, rank}].
// Returns the batch_id.
function logSuggestionBatch(picks, context = {}) {
  const batchId = crypto.randomUUID();
  const ins = db.prepare(`
    INSERT INTO suggestion_log (batch_id, meal_id, rank, context_json) VALUES (?, ?, ?, ?)
  `);
  const ctx = JSON.stringify(context || {});
  const tx = db.transaction(() => {
    for (const p of picks) ins.run(batchId, p.meal_id, p.rank, ctx);
  });
  tx();
  return batchId;
}

// Resolve a batch: either one meal was chosen (others → 'passed'), or the whole
// batch was rejected. Returns number of rows updated (0 = unknown batch).
function resolveSuggestionBatch(batchId, { chosenMealId = null, rejected = false } = {}) {
  const rows = db.prepare('SELECT id, meal_id FROM suggestion_log WHERE batch_id = ?').all(batchId);
  if (!rows.length) return 0;
  const upd = db.prepare(`UPDATE suggestion_log SET outcome = ?, resolved_at = datetime('now') WHERE id = ?`);
  const tx = db.transaction(() => {
    for (const r of rows) {
      const outcome = rejected ? 'rejected' : (r.meal_id === chosenMealId ? 'chosen' : 'passed');
      upd.run(outcome, r.id);
    }
  });
  tx();
  return rows.length;
}

function listSuggestionBatches({ limit = 50 } = {}) {
  const rows = db.prepare(`
    SELECT s.batch_id, s.rank, s.outcome, s.context_json, s.created_at, s.resolved_at,
           m.id AS meal_id, m.name AS meal_name
    FROM suggestion_log s
    LEFT JOIN meals m ON m.id = s.meal_id
    ORDER BY s.created_at DESC, s.batch_id, s.rank
    LIMIT ?
  `).all(limit * 5);
  const byBatch = new Map();
  for (const r of rows) {
    if (!byBatch.has(r.batch_id)) {
      if (byBatch.size >= limit) break;
      byBatch.set(r.batch_id, {
        batch_id: r.batch_id,
        created_at: r.created_at,
        resolved_at: r.resolved_at,
        context: safeJSON(r.context_json) || {},
        picks: [],
      });
    }
    byBatch.get(r.batch_id).picks.push({ meal_id: r.meal_id, name: r.meal_name, rank: r.rank, outcome: r.outcome });
  }
  return Array.from(byBatch.values());
}

// --- App settings (key/value JSON) --------------------------------------

function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  if (!row) return fallback;
  const parsed = safeJSON(row.value);
  return parsed == null ? fallback : parsed;
}

function setSetting(key, value) {
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, JSON.stringify(value ?? null));
  return getSetting(key);
}

// On first boot, seed the ComfyUI config from env vars if present and no
// config has been saved yet. Mirrors the AI-config env seeding above.
(function seedComfyUIFromEnv() {
  const existing = db.prepare(`SELECT 1 FROM app_settings WHERE key = 'comfyui'`).get();
  if (existing) return;
  const base = (process.env.COMFYUI_BASE_URL || '').trim();
  if (!base) return;
  setSetting('comfyui', {
    base_url:        base,
    workflow_json:   (process.env.COMFYUI_WORKFLOW_JSON || '').trim(),
    prompt_template: (process.env.COMFYUI_PROMPT_TEMPLATE || '').trim(),
  });
  console.log(`[comfyui] seeded config from env: base=${base}`);
})();

module.exports = {
  db,
  getOrCreateTag,
  tagsForMeal,
  attachTagsToMeals,
  attachPhotosToMeals,
  bulkImportMeals,
  setMealTags,
  safeJSON,
  DATA_DIR,
  // AI configs
  VALID_AI_PROVIDERS,
  listAiConfigs,
  getActiveAiConfig,
  getAiConfigById,
  createAiConfig,
  updateAiConfig,
  deleteAiConfig,
  activateAiConfig,
  // Agent tokens
  listAgentTokens,
  createAgentToken,
  deleteAgentToken,
  verifyAgentToken,
  agentTokenCount,
  // App settings
  getSetting,
  setSetting,
  // Eaters + suggestion feedback
  EATERS,
  VALID_REACTIONS,
  defaultEaterForSlot,
  logSuggestionBatch,
  resolveSuggestionBatch,
  listSuggestionBatches,
};
