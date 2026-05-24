// Pluggable AI vision provider for food-photo analysis.
//
// Configured by env vars:
//   AI_PROVIDER  = openai | anthropic | ollama | openai-compatible | openrouter | none
//                  (default: none)
//   AI_API_KEY   = secret token (not required for ollama; required for everything else)
//   AI_MODEL     = model name override
//   AI_BASE_URL  = base URL override (for self-hosted endpoints, OpenRouter, etc.)
//
// All providers return the same parsed JSON shape — see SCHEMA below.
//
// URL handling rules (important):
//   - For OpenAI-format providers, AI_BASE_URL may or may not include a trailing
//     /v1. We normalise so that BOTH work:
//        https://api.openai.com           → POST {base}/v1/chat/completions
//        https://api.openai.com/v1        → POST {base}/chat/completions
//        http://ollama.local:11434/v1     → POST {base}/chat/completions
//        https://openrouter.ai/api/v1     → POST {base}/chat/completions
//   - For provider=ollama, if AI_BASE_URL ends with /v1 we transparently switch
//     to the OpenAI-compatible code path (Ollama supports both surfaces).
//   - For provider=ollama with a plain base (no /v1), the native /api/generate
//     endpoint is used.

const PROVIDER = (process.env.AI_PROVIDER || 'none').toLowerCase();
const API_KEY  = process.env.AI_API_KEY || '';
const MODEL    = process.env.AI_MODEL || '';
const BASE_URL = process.env.AI_BASE_URL || '';

const SCHEMA = `{
  "description": string,
  "dish_name": string|null,
  "cuisine": string|null,
  "ingredients": string[],
  "tags": string[],                     // free-form descriptors (e.g. "spicy", "vegetarian", "comfort")
  "portion": { "size": "small"|"medium"|"large"|"unknown", "estimated_grams": number|null },
  "nutrition": {
    "calories": number|null,
    "protein_g": number|null,
    "carbs_g": number|null,
    "fat_g": number|null,
    "fiber_g": number|null,
    "sodium_mg": number|null
  },
  "confidence": number                  // 0..1
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

// Providers that speak the OpenAI chat-completions format.
const OPENAI_FAMILY = new Set(['openai', 'openai-compatible', 'openrouter']);

function defaultModel() {
  switch (PROVIDER) {
    case 'openai':            return 'gpt-4o-mini';
    case 'anthropic':         return 'claude-3-5-sonnet-latest';
    case 'ollama':            return 'llava';
    case 'openrouter':        return 'openai/gpt-4o-mini';
    case 'openai-compatible': return '';   // user must specify
    default:                  return '';
  }
}

function defaultBaseUrl() {
  switch (PROVIDER) {
    case 'openai':            return 'https://api.openai.com';
    case 'anthropic':         return 'https://api.anthropic.com';
    case 'ollama':            return 'http://localhost:11434';
    case 'openrouter':        return 'https://openrouter.ai/api/v1';
    case 'openai-compatible': return '';
    default:                  return '';
  }
}

function isEnabled() {
  if (PROVIDER === 'none') return false;
  if (PROVIDER === 'ollama') return true;            // local, no key
  if (PROVIDER === 'openai-compatible') return Boolean(BASE_URL);  // key may be optional for some local servers
  return Boolean(API_KEY);
}

function info() {
  const provider = PROVIDER;
  const model = MODEL || defaultModel();
  const baseUrl = (BASE_URL || defaultBaseUrl()).replace(/\/+$/, '');
  return { enabled: isEnabled(), provider, model, base_url: baseUrl };
}

// Build the OpenAI chat-completions URL, gracefully handling whether the
// caller already included /v1 in the base.
function openaiChatUrl() {
  const base = (BASE_URL || defaultBaseUrl()).replace(/\/+$/, '');
  if (!base) throw new Error('AI_BASE_URL is required for this provider');
  return /\/v\d+$/.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
}

function ollamaNativeUrl() {
  // Strip an accidentally-included /v1 for the native API.
  const base = (BASE_URL || defaultBaseUrl()).replace(/\/+$/, '').replace(/\/v\d+$/, '');
  return `${base}/api/generate`;
}

function ollamaTagsUrl() {
  const base = (BASE_URL || defaultBaseUrl()).replace(/\/+$/, '').replace(/\/v\d+$/, '');
  return `${base}/api/tags`;
}

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

// ---------------------------------------------------------------------------
// Public: analyse a single food photo.
// ---------------------------------------------------------------------------
async function analyzePhoto({ buffer, mime }) {
  if (!isEnabled()) throw new Error('AI provider not configured (set AI_PROVIDER + AI_API_KEY or AI_BASE_URL)');
  const model = MODEL || defaultModel();
  if (!model) throw new Error('No model configured. Set AI_MODEL for this provider.');

  // Special-case: ollama with a /v1 base URL means the user wants the
  // OpenAI-compatible surface. Route accordingly.
  if (PROVIDER === 'ollama' && /\/v\d+\/?$/.test(BASE_URL)) {
    return analyzeOpenAIFamily({ buffer, mime, model });
  }

  if (OPENAI_FAMILY.has(PROVIDER)) return analyzeOpenAIFamily({ buffer, mime, model });
  if (PROVIDER === 'anthropic')    return analyzeAnthropic({ buffer, mime, model });
  if (PROVIDER === 'ollama')       return analyzeOllamaNative({ buffer, mime, model });
  throw new Error(`Unknown AI provider: ${PROVIDER}`);
}

// ---------------------------------------------------------------------------
// Public: cheap connection test. Returns { ok: true, ... } or throws.
// Tries to list models / hit a low-cost endpoint to verify auth + URL.
// ---------------------------------------------------------------------------
async function testConnection() {
  if (PROVIDER === 'none') throw new Error('AI_PROVIDER is "none"');

  // For Ollama native, /api/tags lists installed models — fast and unauth.
  if (PROVIDER === 'ollama' && !/\/v\d+\/?$/.test(BASE_URL)) {
    const res = await fetchWithDetail(ollamaTagsUrl(), { method: 'GET' });
    const data = await res.json().catch(() => ({}));
    return {
      ok: true, provider: PROVIDER, base_url: ollamaTagsUrl(),
      models: (data.models || []).map(m => m.name),
      configured_model: MODEL || defaultModel(),
    };
  }

  // OpenAI-family: GET /models is the cheap test.
  if (OPENAI_FAMILY.has(PROVIDER) || PROVIDER === 'ollama') {
    const base = (BASE_URL || defaultBaseUrl()).replace(/\/+$/, '');
    const url = /\/v\d+$/.test(base) ? `${base}/models` : `${base}/v1/models`;
    const res = await fetchWithDetail(url, {
      method: 'GET',
      headers: API_KEY ? { 'Authorization': `Bearer ${API_KEY}` } : {},
    });
    const data = await res.json().catch(() => ({}));
    const models = Array.isArray(data.data) ? data.data.map(m => m.id) : [];
    return { ok: true, provider: PROVIDER, base_url: url, models, configured_model: MODEL || defaultModel() };
  }

  if (PROVIDER === 'anthropic') {
    // Anthropic has no cheap probe endpoint; do a 1-token text completion.
    const url = (BASE_URL || defaultBaseUrl()).replace(/\/+$/, '') + '/v1/messages';
    const res = await fetchWithDetail(url, {
      method: 'POST',
      headers: { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL || defaultModel(),
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });
    await res.json().catch(() => ({}));
    return { ok: true, provider: PROVIDER, base_url: url, configured_model: MODEL || defaultModel() };
  }

  throw new Error(`Unknown AI provider: ${PROVIDER}`);
}

// ---------------------------------------------------------------------------
// Concrete callers
// ---------------------------------------------------------------------------
async function analyzeOpenAIFamily({ buffer, mime, model }) {
  const url = openaiChatUrl();
  const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;
  const headers = { 'Content-Type': 'application/json' };
  if (API_KEY) headers['Authorization'] = `Bearer ${API_KEY}`;
  // OpenRouter recommends these for analytics; harmless elsewhere.
  if (PROVIDER === 'openrouter') {
    headers['X-Title'] = 'yes-chef';
  }

  const res = await fetchWithDetail(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      // Not every OpenAI-compatible server supports response_format. Try it,
      // but fall back to plain on 400 (handled by the caller via the error text).
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

async function analyzeAnthropic({ buffer, mime, model }) {
  const url = (BASE_URL || defaultBaseUrl()).replace(/\/+$/, '') + '/v1/messages';
  const res = await fetchWithDetail(url, {
    method: 'POST',
    headers: {
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
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

async function analyzeOllamaNative({ buffer, mime, model }) {
  const url = ollamaNativeUrl();
  const res = await fetchWithDetail(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt: SYSTEM_PROMPT + '\n\nAnalyze this food photo.',
      images: [buffer.toString('base64')],
      stream: false,
      format: 'json',
    }),
  });
  const data = await res.json();
  return parseJSONLoose(data.response || '');
}

// fetch wrapper that turns non-2xx responses into informative errors,
// including the upstream status code AND a snippet of the body.
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

// Log a one-line summary on startup so misconfigurations surface immediately.
if (PROVIDER !== 'none') {
  const i = info();
  console.log(`[ai] provider=${i.provider} model=${i.model || '(unset)'} base=${i.base_url || '(default)'} enabled=${i.enabled}`);
  if (!i.enabled) {
    if (OPENAI_FAMILY.has(PROVIDER) && PROVIDER !== 'openai-compatible' && !API_KEY) {
      console.warn(`[ai] AI_API_KEY is empty — provider "${PROVIDER}" needs one.`);
    }
    if (PROVIDER === 'openai-compatible' && !BASE_URL) {
      console.warn(`[ai] AI_BASE_URL is required for openai-compatible.`);
    }
  }
}

module.exports = { analyzePhoto, testConnection, isEnabled, info };
