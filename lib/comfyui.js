// ComfyUI image generation.
//
// Generates a dish image for a meal by submitting a saved ComfyUI workflow
// (API format) to a self-hosted ComfyUI server, then downloading the result.
//
// Configuration lives in the `app_settings` table under the key "comfyui":
//   { base_url, workflow_json, prompt_template }
//
//   base_url        e.g. http://localhost:8188 (or your Docker host)
//   workflow_json   a ComfyUI workflow exported in *API format*
//                   (the "Save (API Format)" button), with the literal token
//                   %prompt% wherever the positive text prompt should go.
//   prompt_template optional text template; "{meal}" is replaced with the
//                   meal name. Defaults to a food-photography prompt.
//
// Public API:
//   getConfig()              → stored config object (or defaults)
//   isEnabled()              → boolean (base_url + workflow_json present)
//   info()                   → { enabled, base_url, has_workflow, prompt_template }
//   buildPrompt(mealName)    → resolved positive prompt string
//   testConnection(cfg?)     → throws on failure; returns { ok, base_url, ... }
//   generateImage({prompt})  → { buffer, mime, filename }

const { getSetting } = require('../db');

const DEFAULT_PROMPT_TEMPLATE =
  'professional food photography of {meal}, plated on a clean dish, natural soft lighting, shallow depth of field, appetizing, high detail';

const EXT_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  webp: 'image/webp', gif: 'image/gif',
};

function getConfig() {
  const cfg = getSetting('comfyui', {}) || {};
  // Back-compat: the original single-workflow field was `workflow_json`; treat
  // it as the text-to-image workflow if the newer field is absent.
  const txt2img = String(cfg.workflow_txt2img || cfg.workflow_json || '').trim();
  return {
    base_url:          String(cfg.base_url || '').trim().replace(/\/+$/, ''),
    prompt_template:   String(cfg.prompt_template || '').trim(),
    workflow_txt2img:  txt2img,
    workflow_img2img:  String(cfg.workflow_img2img || '').trim(),
  };
}

// txt2img is the baseline capability; img2img also needs its own workflow.
function isEnabled() {
  const c = getConfig();
  return Boolean(c.base_url && c.workflow_txt2img);
}
function hasImg2Img() {
  const c = getConfig();
  return Boolean(c.base_url && c.workflow_img2img);
}

function info() {
  const c = getConfig();
  return {
    enabled:         isEnabled(),          // text-to-image available
    img2img:         hasImg2Img(),         // image-to-image available
    base_url:        c.base_url,
    has_txt2img:     Boolean(c.workflow_txt2img),
    has_img2img:     Boolean(c.workflow_img2img),
    prompt_template: c.prompt_template || DEFAULT_PROMPT_TEMPLATE,
  };
}

function buildPrompt(mealName) {
  const c = getConfig();
  const tpl = c.prompt_template || DEFAULT_PROMPT_TEMPLATE;
  const name = String(mealName || '').trim() || 'a meal';
  return tpl.includes('{meal}') ? tpl.split('{meal}').join(name) : `${tpl} ${name}`.trim();
}

// JSON-escape a string for safe substitution into a quoted JSON field
// (drop the surrounding quotes JSON.stringify adds).
function jsonEscape(s) { return JSON.stringify(String(s)).slice(1, -1); }

// Replace the %prompt% (and, for img2img, %image%) placeholders in the
// workflow template, then parse the result into a workflow graph.
//   subs = { prompt, imageRef? }
// imageRef is required when the workflow contains %image%.
function buildWorkflow(workflowJson, subs = {}) {
  if (!workflowJson) throw new Error('No ComfyUI workflow configured. Add one in Settings.');
  if (!workflowJson.includes('%prompt%')) {
    throw new Error('Workflow is missing the %prompt% placeholder — put it in your positive-prompt node.');
  }
  const needsImage = workflowJson.includes('%image%');
  if (needsImage && !subs.imageRef) {
    throw new Error('Workflow expects an %image% but none was supplied.');
  }
  let filled = workflowJson.split('%prompt%').join(jsonEscape(subs.prompt));
  if (needsImage) filled = filled.split('%image%').join(jsonEscape(subs.imageRef));
  try {
    return JSON.parse(filled);
  } catch (err) {
    throw new Error(`Workflow JSON is invalid after substitution: ${err.message}`);
  }
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

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Probe the server is reachable. ComfyUI exposes /system_stats.
async function testConnection(cfg) {
  const c = cfg || getConfig();
  if (!c.base_url) throw new Error('base_url is required');
  const url = `${c.base_url.replace(/\/+$/, '')}/system_stats`;
  const res = await fetchWithDetail(url, { method: 'GET' });
  const data = await res.json().catch(() => ({}));
  return {
    ok: true,
    base_url: c.base_url,
    has_txt2img: Boolean(c.workflow_txt2img),
    has_img2img: Boolean(c.workflow_img2img),
    system: data?.system || null,
  };
}

// Upload an image into ComfyUI's input dir so a LoadImage node can use it.
// Returns the reference string to drop into the node ("name" or "subfolder/name").
async function uploadImage(base, buffer, mime, filename) {
  const fd = new FormData();
  fd.append('image', new Blob([buffer], { type: mime || 'image/png' }), filename || 'base.png');
  fd.append('overwrite', 'true');
  const res = await fetchWithDetail(`${base}/upload/image`, { method: 'POST', body: fd });
  const data = await res.json().catch(() => ({}));
  if (!data.name) throw new Error(`ComfyUI /upload/image returned no name. Response: ${JSON.stringify(data).slice(0, 200)}`);
  return data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
}

// Submit the workflow and return the first generated image as bytes.
// Options:
//   prompt      positive-prompt text (fills %prompt%)
//   mode        'txt2img' (default) or 'img2img'
//   inputImage  { buffer, mime, filename } — required for img2img; uploaded
//               to ComfyUI and referenced via %image%
async function generateImage({ prompt, mode = 'txt2img', inputImage = null, timeoutMs = 120000, pollMs = 1500 } = {}) {
  const c = getConfig();
  if (!c.base_url) throw new Error('No ComfyUI server configured. Set the base URL in Settings.');
  const base = c.base_url;

  let workflow;
  if (mode === 'img2img') {
    if (!c.workflow_img2img) throw new Error('No image-to-image workflow configured. Add one in Settings.');
    if (!inputImage?.buffer)  throw new Error('img2img needs a base image but none was provided.');
    const imageRef = await uploadImage(base, inputImage.buffer, inputImage.mime, inputImage.filename);
    workflow = buildWorkflow(c.workflow_img2img, { prompt, imageRef });
  } else {
    workflow = buildWorkflow(c.workflow_txt2img, { prompt });
  }

  const clientId = `yes-chef-${Math.floor(Date.now())}`;

  // 1. Queue the prompt.
  const queueRes = await fetchWithDetail(`${base}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: clientId }),
  });
  const queued = await queueRes.json().catch(() => ({}));
  const promptId = queued.prompt_id;
  if (!promptId) {
    throw new Error(`ComfyUI did not return a prompt_id. Response: ${JSON.stringify(queued).slice(0, 300)}`);
  }

  // 2. Poll history until the prompt completes (or we time out).
  const deadline = Date.now() + timeoutMs;
  let outputs = null;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    const hRes = await fetchWithDetail(`${base}/history/${promptId}`, { method: 'GET' });
    const hist = await hRes.json().catch(() => ({}));
    const entry = hist[promptId];
    if (entry && entry.outputs) {
      const status = entry.status?.status_str;
      if (status === 'error') {
        throw new Error('ComfyUI reported an error running the workflow. Check the server logs / queue.');
      }
      outputs = entry.outputs;
      break;
    }
  }
  if (!outputs) throw new Error(`Timed out waiting for ComfyUI to finish (>${Math.round(timeoutMs / 1000)}s).`);

  // 3. Find the first image output across all nodes.
  let image = null;
  for (const nodeId of Object.keys(outputs)) {
    const imgs = outputs[nodeId]?.images;
    if (Array.isArray(imgs) && imgs.length) { image = imgs[0]; break; }
  }
  if (!image) throw new Error('Workflow finished but produced no image output (need a SaveImage node).');

  // 4. Download the image bytes via /view.
  const params = new URLSearchParams({
    filename:  image.filename,
    subfolder: image.subfolder || '',
    type:      image.type || 'output',
  });
  const viewRes = await fetchWithDetail(`${base}/view?${params.toString()}`, { method: 'GET' });
  const arrBuf = await viewRes.arrayBuffer();
  const buffer = Buffer.from(arrBuf);
  const ext = (image.filename.split('.').pop() || 'png').toLowerCase();
  const mime = EXT_MIME[ext] || viewRes.headers.get('content-type') || 'image/png';
  return { buffer, mime, filename: image.filename };
}

module.exports = {
  getConfig, isEnabled, hasImg2Img, info, buildPrompt, testConnection, generateImage,
  DEFAULT_PROMPT_TEMPLATE,
};
