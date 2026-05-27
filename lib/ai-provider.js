// Pluggable AI vision provider for food-photo analysis.
//
// Configuration lives in the DB (table `ai_configs`). Multiple named configs
// can exist; the one with is_active=1 is used. The active config can be
// switched at runtime from the UI — no restart needed. On first boot, if the
// table is empty and the legacy AI_* env vars are set, a config is seeded.
//
// Public API:
//   info()                   → { enabled, provider, model, base_url, label, id, ... }
//   isEnabled()              → boolean
//   analyzePhoto({buf,mime}) → parsed JSON matching SCHEMA
//   testConnection(config?)  → throws on failure; returns { ok, models?, ... }
//
// Anything that takes `config` accepts either a DB row (with api_key, base_url,
// provider, model) OR omits it, in which case the active DB config is used.

const { getActiveAiConfig, getAiConfigById } = require('../db');

const SCHEMA = `{
  "description": string,
  "dish_name": string|null,
  "cuisine": string|null,
  "ingredients": string[],
  "tags": string[],
  "portion": { "size": "small"|"medium"|"large"|"unknown", "estimated_grams": number|null },
  "nutrition": {
    "calories": number|null,
    "protein_g": number|null,
    "carbs_g": number|null,
    "fat_g": number|null,
    "fiber_g": number|null,
    "sodium_mg": number|null
  },
  "confidence": number
}`;

const SYSTEM_PROMPT =
`You are a nutrition-aware food vision model. Look at a single photo of a meal and respond with STRICT JSON matching this schema:
${SCHEMA}

Rules:
- Respond with JSON only. No code fences, no commentary.
- Estimate nutrition for the visible portion. Use null for any value you truly cannot estimate.
- Tags should be short, lowercase, and useful for filtering (e.g. "spicy", "vegetarian", "quick", "asian", "comfort food").
- "cuisine" is a single broad label (e.g. "italian", "mexican", "indian").
- "confidence" reflects overall certainty across all fields.`;

const OPENAI_FAMILY = new Set(['openai', 'openai-compatible', 'openrouter']);

function defaultModel(provider) {
  switch (provider) {
    case 'openai':            return 'gpt-4o-mini';
    case 'anthropic':         return 'claude-3-5-sonnet-latest';
    case 'ollama':            return 'llava';
    case 'openrouter':        return 'openai/gpt-4o-mini';
    case 'openai-compatible': return '';
    default:                  return '';
  }
}
function defaultBaseUrl(provider) {
  switch (provider) {
    case 'openai':            return 'https://api.openai.com';
    case 'anthropic':         return 'https://api.anthropic.com';
    case 'ollama':            return 'http://localhost:11434';
    case 'openrouter':        return 'https://openrouter.ai/api/v1';
    case 'openai-compatible': return '';
    default:                  return '';
  }
}

// Normalize a DB row (or partial object) into a usable config object.
function resolveConfig(row) {
  if (!row) return null;
  const provider = String(row.provider || '').toLowerCase();
  const model    = (row.model    || '').trim() || defaultModel(provider);
  const base_url = (row.base_url || '').trim() || defaultBaseUrl(provider);
  const api_key  = (row.api_key  || '').trim();
  return {
    id: row.id || null,
    label: row.label || provider,
    provider, model, api_key,
    base_url: base_url.replace(/\/+$/, ''),
  };
}

function activeConfig() {
  return resolveConfig(getActiveAiConfig());
}

function isConfigEnabled(cfg) {
  if (!cfg) return false;
  const p = cfg.provider;
  if (p === 'ollama') return Boolean(cfg.base_url);                 // local; no key
  if (p === 'openai-compatible') return Boolean(cfg.base_url);      // key optional
  if (OPENAI_FAMILY.has(p) || p === 'anthropic') return Boolean(cfg.api_key);
  return false;
}

function isEnabled() {
  return isConfigEnabled(activeConfig());
}

function info() {
  const cfg = activeConfig();
  if (!cfg) {
    return { enabled: false, provider: 'none', model: '', base_url: '', label: '(no config)', id: null };
  }
  return {
    enabled:  isConfigEnabled(cfg),
    id:       cfg.id,
    label:    cfg.label,
    provider: cfg.provider,
    model:    cfg.model,
    base_url: cfg.base_url,
  };
}

// ---- URL helpers (per-config, no module-level globals) -----------------

function openaiChatUrl(cfg) {
  if (!cfg.base_url) throw new Error('base_url is required for this provider');
  return /\/v\d+$/.test(cfg.base_url) ? `${cfg.base_url}/chat/completions` : `${cfg.base_url}/v1/chat/completions`;
}
function openaiModelsUrl(cfg) {
  if (!cfg.base_url) throw new Error('base_url is required');
  return /\/v\d+$/.test(cfg.base_url) ? `${cfg.base_url}/models` : `${cfg.base_url}/v1/models`;
}
function ollamaNativeUrl(cfg) { return cfg.base_url.replace(/\/v\d+$/, '') + '/api/generate'; }
function ollamaTagsUrl(cfg)   { return cfg.base_url.replace(/\/v\d+$/, '') + '/api/tags'; }
function anthropicUrl(cfg)    { return cfg.base_url + '/v1/messages'; }

function stripFences(s) {
  return String(s).replace(/^\s*```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
}
function parseJSONLoose(s) {
  const cleaned = stripFences(s);
  try { return JSON.parse(cleaned); } catch {}
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  throw new Error('AI response was not valid JSON');
}

// ---- Public: analyse a single food photo --------------------------------

async function analyzePhoto({ buffer, mime, configId } = {}) {
  const cfg = configId
    ? resolveConfig(getAiConfigById(configId))
    : activeConfig();
  if (!cfg) throw new Error('No AI configuration available. Add one in Settings.');
  if (!isConfigEnabled(cfg)) {
    throw new Error(`AI config "${cfg.label}" is not enabled. Check the API key / base URL.`);
  }
  if (!cfg.model) throw new Error(`No model set for AI config "${cfg.label}".`);

  // Ollama with a /v1 base URL → OpenAI-compatible surface.
  if (cfg.provider === 'ollama' && /\/v\d+$/.test(cfg.base_url)) {
    return analyzeOpenAIFamily(cfg, buffer, mime);
  }
  if (OPENAI_FAMILY.has(cfg.provider)) return analyzeOpenAIFamily(cfg, buffer, mime);
  if (cfg.provider === 'anthropic')    return analyzeAnthropic(cfg, buffer, mime);
  if (cfg.provider === 'ollama')       return analyzeOllamaNative(cfg, buffer, mime);
  throw new Error(`Unknown AI provider: ${cfg.provider}`);
}

// ---- Public: cheap connection test -------------------------------------
// Accepts either a config id, a full config object, or nothing (= active).
async function testConnection(arg) {
  let cfg;
  if (!arg) cfg = activeConfig();
  else if (typeof arg === 'number') cfg = resolveConfig(getAiConfigById(arg));
  else if (typeof arg === 'object') cfg = resolveConfig(arg);
  if (!cfg) throw new Error('No AI configuration to test.');

  const p = cfg.provider;

  if (p === 'ollama' && !/\/v\d+$/.test(cfg.base_url)) {
    const res = await fetchWithDetail(ollamaTagsUrl(cfg), { method: 'GET' });
    const data = await res.json().catch(() => ({}));
    return {
      ok: true, provider: p, label: cfg.label, base_url: ollamaTagsUrl(cfg),
      models: (data.models || []).map(m => m.name),
      configured_model: cfg.model,
    };
  }

  if (OPENAI_FAMILY.has(p) || p === 'ollama') {
    const url = openaiModelsUrl(cfg);
    const res = await fetchWithDetail(url, {
      method: 'GET',
      headers: cfg.api_key ? { 'Authorization': `Bearer ${cfg.api_key}` } : {},
    });
    const data = await res.json().catch(() => ({}));
    const models = Array.isArray(data.data) ? data.data.map(m => m.id) : [];
    return { ok: true, provider: p, label: cfg.label, base_url: url, models, configured_model: cfg.model };
  }

  if (p === 'anthropic') {
    const url = anthropicUrl(cfg);
    const res = await fetchWithDetail(url, {
      method: 'POST',
      headers: { 'x-api-key': cfg.api_key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: cfg.model, max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });
    await res.json().catch(() => ({}));
    return { ok: true, provider: p, label: cfg.label, base_url: url, configured_model: cfg.model };
  }

  throw new Error(`Unknown AI provider: ${p}`);
}

// ---- Concrete callers ---------------------------------------------------

async function analyzeOpenAIFamily(cfg, buffer, mime) {
  const url = openaiChatUrl(cfg);
  const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.api_key) headers['Authorization'] = `Bearer ${cfg.api_key}`;
  if (cfg.provider === 'openrouter') headers['X-Title'] = 'yes-chef';

  const res = await fetchWithDetail(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: cfg.model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: [
          { type: 'text',      text: 'Analyze this food photo.' },
          { type: 'image_url', image_url: { url: dataUrl } },
        ]},
      ],
    }),
  });
  const data = await res.json();
  return parseJSONLoose(data.choices?.[0]?.message?.content || '');
}

async function analyzeAnthropic(cfg, buffer, mime) {
  const url = anthropicUrl(cfg);
  const res = await fetchWithDetail(url, {
    method: 'POST',
    headers: {
      'x-api-key': cfg.api_key,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mime, data: buffer.toString('base64') } },
          { type: 'text',  text: 'Analyze this food photo. Return JSON only.' },
        ],
      }],
    }),
  });
  const data = await res.json();
  return parseJSONLoose(data.content?.[0]?.text || '');
}

async function analyzeOllamaNative(cfg, buffer, mime) {
  const url = ollamaNativeUrl(cfg);
  const res = await fetchWithDetail(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: cfg.model,
      prompt: SYSTEM_PROMPT + '\n\nAnalyze this food photo.',
      images: [buffer.toString('base64')],
      stream: false,
      format: 'json',
    }),
  });
  const data = await res.json();
  return parseJSONLoose(data.response || '');
}

async function fetchWithDetail(url, opts) {
  let res;
  try {
    res = await fetch(url, opts);
  } catch (err) {
    throw new Error(`Network error contacting ${url}: ${err.message}`);
  }
  if (!res.ok) {
    let body = '';
    try { body = await res.text(); } catch {}
    const snippet = body.length > 400 ? body.slice(0, 400) + '…' : body;
    throw new Error(`${url} → HTTP ${res.status} ${res.statusText}${snippet ? ': ' + snippet : ''}`);
  }
  return res;
}

// Boot log
try {
  const i = info();
  if (i.provider !== 'none') {
    console.log(`[ai] active config #${i.id} "${i.label}": provider=${i.provider} model=${i.model || '(unset)'} base=${i.base_url || '(default)'} enabled=${i.enabled}`);
  } else {
    console.log('[ai] no configurations — add one in Settings to enable photo analysis.');
  }
} catch (err) {
  console.warn('[ai] boot info failed:', err.message);
}

module.exports = { analyzePhoto, testConnection, isEnabled, info };
