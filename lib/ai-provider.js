// Pluggable AI vision provider for food-photo analysis.
//
// Configured by env vars:
//   AI_PROVIDER  = openai | anthropic | ollama | none   (default: none)
//   AI_API_KEY   = secret token (not required for ollama)
//   AI_MODEL     = model name override
//   AI_BASE_URL  = base URL override (for self-hosted endpoints / Ollama)
//
// All providers return the same parsed JSON shape — see SCHEMA below.

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

function isEnabled() {
  if (PROVIDER === 'none') return false;
  if (PROVIDER === 'ollama') return true;     // local, no key needed
  return Boolean(API_KEY);
}

function info() {
  return { enabled: isEnabled(), provider: PROVIDER, model: MODEL || defaultModel() };
}

function defaultModel() {
  switch (PROVIDER) {
    case 'openai':    return 'gpt-4o-mini';
    case 'anthropic': return 'claude-3-5-sonnet-latest';
    case 'ollama':    return 'llava';
    default:          return '';
  }
}

function stripFences(s) {
  return String(s).replace(/^\s*```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
}

function parseJSONLoose(s) {
  const cleaned = stripFences(s);
  try { return JSON.parse(cleaned); } catch {}
  // Last-ditch: grab the first {...} blob.
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  throw new Error('AI response was not valid JSON');
}

async function analyzePhoto({ buffer, mime }) {
  if (!isEnabled()) throw new Error('AI provider not configured');
  const ctx = { buffer, mime, model: MODEL || defaultModel() };
  switch (PROVIDER) {
    case 'openai':    return analyzeOpenAI(ctx);
    case 'anthropic': return analyzeAnthropic(ctx);
    case 'ollama':    return analyzeOllama(ctx);
    default: throw new Error(`Unknown AI provider: ${PROVIDER}`);
  }
}

async function analyzeOpenAI({ buffer, mime, model }) {
  const url = (BASE_URL || 'https://api.openai.com') + '/v1/chat/completions';
  const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
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
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return parseJSONLoose(data.choices?.[0]?.message?.content || '');
}

async function analyzeAnthropic({ buffer, mime, model }) {
  const url = (BASE_URL || 'https://api.anthropic.com') + '/v1/messages';
  const res = await fetch(url, {
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
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data.content?.[0]?.text || '';
  return parseJSONLoose(text);
}

async function analyzeOllama({ buffer, mime, model }) {
  const url = (BASE_URL || 'http://localhost:11434') + '/api/generate';
  const res = await fetch(url, {
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
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return parseJSONLoose(data.response || '');
}

module.exports = { analyzePhoto, isEnabled, info };
