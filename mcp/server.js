#!/usr/bin/env node
// yes-chef MCP server (stdio transport).
//
// A thin adapter over the yes-chef agent API (/api/v1/agent/*). It lets an MCP
// client — Claude Desktop, Claude Code, etc. — plan lunches, log what you ate,
// get recommendations, push reminders, and generate dish images, all through
// your existing bearer token. The web app itself is unchanged.
//
// Configuration (environment variables):
//   YESCHEF_BASE_URL   Base URL of your yes-chef server, e.g.
//                      https://menu.example.com  or  http://localhost:3000
//   YESCHEF_TOKEN      An agent API token (Settings -> Agent API tokens)
//
// Run:  YESCHEF_BASE_URL=... YESCHEF_TOKEN=... node server.js

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BASE = (process.env.YESCHEF_BASE_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.YESCHEF_TOKEN || '';

if (!BASE || !TOKEN) {
  // Write to stderr (stdout is the JSON-RPC channel) and exit.
  console.error('[yes-chef-mcp] Missing config. Set YESCHEF_BASE_URL and YESCHEF_TOKEN.');
  process.exit(1);
}

// ---- tiny HTTP client over the agent API ----
async function call(method, path, body) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: body != null ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new Error(`Could not reach yes-chef at ${BASE}: ${err.message}`);
  }
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = data && typeof data === 'object' ? (data.error || JSON.stringify(data)) : String(data);
    const detail = data && data.detail ? ` — ${data.detail}` : '';
    throw new Error(`HTTP ${res.status}: ${msg}${detail}`);
  }
  return data;
}

// Format a tool result as MCP text content.
const ok = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });
const fail = (msg) => ({ isError: true, content: [{ type: 'text', text: String(msg) }] });

// Local-date ISO (avoid UTC off-by-one).
function toISO(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function todayISO() { return toISO(new Date()); }
function nextWeekdays(n = 5) {
  const out = [];
  const d = new Date();
  while (out.length < n) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) out.push(toISO(d));
  }
  return out;
}

// Resolve a meal reference (numeric id or name) to a meal id.
// If it's a name with no exact match, optionally create it.
async function resolveMealId(ref, { createIfMissing = false } = {}) {
  if (typeof ref === 'number' || /^\d+$/.test(String(ref).trim())) {
    return Number(ref);
  }
  const name = String(ref).trim();
  const { meals = [] } = await call('GET', `/api/v1/agent/meals?q=${encodeURIComponent(name)}`);
  const exact = meals.find(m => m.name.toLowerCase() === name.toLowerCase());
  if (exact) return exact.id;
  if (meals.length === 1) return meals[0].id;
  if (createIfMissing) {
    const { meal } = await call('POST', '/api/v1/agent/meals', { name });
    return meal.id;
  }
  if (meals.length > 1) {
    throw new Error(`"${name}" is ambiguous — matches: ${meals.map(m => m.name).join(', ')}. Use an exact name or id.`);
  }
  throw new Error(`No meal named "${name}". Pass create_if_missing=true to create it, or create_meal first.`);
}

const server = new McpServer({ name: 'yes-chef', version: '0.1.0' });

// ---------------------------------------------------------------- read tools
server.tool('list_meals', 'List the meal library, optionally filtered by name query or a tag.',
  { query: z.string().optional(), tag: z.string().optional() },
  async ({ query, tag }) => {
    const qs = new URLSearchParams();
    if (query) qs.set('q', query);
    if (tag) qs.set('tag', tag);
    return ok(await call('GET', `/api/v1/agent/meals${qs.toString() ? '?' + qs : ''}`));
  });

server.tool('get_state', 'Recent + upcoming entries, days that still need planning, and active notes. Good for a briefing.',
  { back: z.number().int().min(0).max(60).optional(), forward: z.number().int().min(0).max(30).optional() },
  async ({ back, forward }) => {
    const qs = new URLSearchParams();
    if (back != null) qs.set('back', String(back));
    if (forward != null) qs.set('forward', String(forward));
    return ok(await call('GET', `/api/v1/agent/state${qs.toString() ? '?' + qs : ''}`));
  });

server.tool('get_stats', 'Eating-history statistics: totals, variety index, streak, top meals, breakdowns.',
  { days: z.number().int().min(7).max(3650).optional() },
  async ({ days }) => ok(await call('GET', `/api/v1/agent/stats${days ? `?days=${days}` : ''}`)));

server.tool('get_recommendations',
  'Top-N meal recommendations. Set log=true when the suggestions will actually be offered (e.g. read aloud to Christine) — the batch is recorded and the response includes batch_id; report what happened with record_suggestion_outcome. The batch/outcome log is the training data for the predictive model.',
  {
    variety: z.number().min(0).max(1).optional(),
    count: z.number().int().min(1).max(25).optional(),
    tag: z.string().optional(),
    avoid_days: z.number().int().min(0).max(365).optional(),
    log: z.boolean().optional().describe('Record this batch as offered suggestions'),
    slot: z.enum(['breakfast', 'lunch', 'side', 'dinner', 'snack']).optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    eater: z.enum(['joseph', 'christine', 'both']).optional(),
  },
  async ({ variety, count, tag, avoid_days, log, slot, date, eater }) => {
    const qs = new URLSearchParams();
    if (variety != null) qs.set('variety', String(variety));
    if (count != null) qs.set('n', String(count));
    if (tag) qs.set('tag', tag);
    if (avoid_days != null) qs.set('avoid_days', String(avoid_days));
    if (log) qs.set('log', '1');
    if (slot) qs.set('slot', slot);
    if (date) qs.set('date', date);
    if (eater) qs.set('eater', eater);
    return ok(await call('GET', `/api/v1/agent/recommendations?${qs}`));
  });

server.tool('record_suggestion_outcome',
  'Record what happened to a logged suggestion batch: which meal was chosen, or that none were. Always call this after offering logged suggestions — it is the feedback the model learns from.',
  {
    batch_id: z.string(),
    chosen_meal_id: z.number().int().optional().describe('The meal that was picked'),
    none: z.boolean().optional().describe('True if all suggestions were declined'),
  },
  async ({ batch_id, chosen_meal_id, none }) =>
    ok(await call('POST', `/api/v1/agent/suggestions/${encodeURIComponent(batch_id)}/outcome`,
      none ? { none: true } : { chosen_meal_id })));

server.tool('suggest_week',
  'Suggest meals to fill a week of lunch slots (preview only — does not save). Defaults to the next 5 weekdays and the lunch slot.',
  {
    dates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional(),
    slots: z.array(z.enum(['breakfast', 'lunch', 'side', 'dinner', 'snack'])).optional(),
    variety: z.number().min(0).max(1).optional(),
    tags: z.array(z.string()).optional(),
    avoid_days: z.number().int().min(0).max(365).optional(),
  },
  async ({ dates, slots, variety, tags, avoid_days }) => ok(await call('POST', '/api/v1/agent/plan/suggest', {
    dates: dates && dates.length ? dates : nextWeekdays(5),
    slots: slots && slots.length ? slots : ['lunch'],
    variety: variety ?? 0.6,
    tags: tags || [],
    avoid_days: avoid_days ?? 14,
  })));

// --------------------------------------------------------------- write tools
server.tool('create_meal', 'Add a meal to the library.',
  { name: z.string(), tags: z.array(z.string()).optional(), notes: z.string().optional() },
  async ({ name, tags, notes }) => ok(await call('POST', '/api/v1/agent/meals', { name, tags: tags || [], notes: notes || '' })));

server.tool('log_meal',
  'Log or plan a meal. Resolves the meal by name (or id). status "eaten" records history; "planned" puts it on the plan. Slot optional; on_date defaults to today. eater = who ate it (joseph | christine | both); if omitted the server defaults by slot (lunch/breakfast/side → christine, else both). reaction "sat_poorly" flags a sensitive-stomach reaction, "liked" a hit.',
  {
    meal: z.string().describe('Meal name or numeric id'),
    on_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    slot: z.enum(['breakfast', 'lunch', 'side', 'dinner', 'snack', '']).optional(),
    status: z.enum(['eaten', 'planned']).optional(),
    eater: z.enum(['joseph', 'christine', 'both']).optional(),
    reaction: z.enum(['liked', 'sat_poorly']).optional(),
    notes: z.string().optional(),
    create_if_missing: z.boolean().optional(),
  },
  async ({ meal, on_date, slot, status, eater, reaction, notes, create_if_missing }) => {
    const meal_id = await resolveMealId(meal, { createIfMissing: create_if_missing !== false });
    return ok(await call('POST', '/api/v1/agent/entries', {
      meal_id,
      on_date: on_date || todayISO(),
      slot: slot ?? '',
      status: status || 'eaten',
      ...(eater ? { eater } : {}),
      ...(reaction ? { reaction } : {}),
      notes: notes || '',
    }));
  });

server.tool('push_note', 'Push a note/reminder that shows as a banner in the web UI.',
  {
    text: z.string(),
    kind: z.enum(['info', 'reminder', 'recommendation', 'warning']).optional(),
    due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  },
  async ({ text, kind, due_date }) => ok(await call('POST', '/api/v1/agent/notes', { text, kind: kind || 'info', due_date })));

server.tool('generate_meal_image',
  'Generate a dish image for a meal via the configured ComfyUI server and save it as a meal photo. mode "txt2img" generates from the prompt; "img2img" transforms an existing photo. Can be slow.',
  {
    meal: z.string().describe('Meal name or numeric id'),
    mode: z.enum(['txt2img', 'img2img']).optional(),
    photo_id: z.number().int().optional().describe('For img2img: which existing photo to use as the base'),
    prompt: z.string().optional().describe('Override the auto-built prompt'),
  },
  async ({ meal, mode, photo_id, prompt }) => {
    const id = await resolveMealId(meal, { createIfMissing: false });
    return ok(await call('POST', `/api/v1/agent/meals/${id}/generate-image`, { mode, photo_id, prompt }));
  });

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[yes-chef-mcp] connected to ${BASE} — 10 tools ready.`);
