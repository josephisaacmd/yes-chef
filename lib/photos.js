// Shared meal-photo helpers: where photo files live, how they're written, and
// the ComfyUI generate-and-save flow. Used by both the session routes
// (routes/meals.js) and the bearer-token agent API (routes/agent.js) so the
// logic isn't duplicated.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { db, DATA_DIR } = require('../db');
const comfy = require('./comfyui');

const PHOTO_DIR = path.join(DATA_DIR, 'photos');
fs.mkdirSync(PHOTO_DIR, { recursive: true });

const MAX_PHOTO_BYTES = 15 * 1024 * 1024; // 15 MB

const MIME_EXT = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
  'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic', 'image/heif': 'heif',
};

function mimeFromName(name) {
  const ext = (String(name).split('.').pop() || '').toLowerCase();
  return {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    webp: 'image/webp', gif: 'image/gif', heic: 'image/heic', heif: 'image/heif',
  }[ext] || 'application/octet-stream';
}

// An error carrying an HTTP status, so callers can map it to a response code.
class HttpError extends Error {
  constructor(status, message, detail) {
    super(message);
    this.status = status;
    if (detail) this.detail = detail;
  }
}

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

// Generate a dish image for `meal` via ComfyUI and save it as a new photo.
//   opts = { mode?: 'txt2img'|'img2img', photo_id?, prompt? }
// Throws HttpError with an appropriate status on misconfiguration / failure.
async function generateMealImage(meal, { mode = 'txt2img', photo_id, prompt } = {}) {
  mode = mode === 'img2img' ? 'img2img' : 'txt2img';
  if (mode === 'txt2img' && !comfy.isEnabled()) {
    throw new HttpError(503, 'ComfyUI is not configured. Set the base URL and a text-to-image workflow in Settings.');
  }
  if (mode === 'img2img' && !comfy.hasImg2Img()) {
    throw new HttpError(503, 'No image-to-image workflow is configured. Add one in Settings.');
  }

  let inputImage = null;
  if (mode === 'img2img') {
    const photoRow = photo_id
      ? db.prepare('SELECT id, filename FROM meal_photos WHERE id = ? AND meal_id = ?').get(photo_id, meal.id)
      : db.prepare('SELECT id, filename FROM meal_photos WHERE meal_id = ? ORDER BY sort_order ASC, id ASC LIMIT 1').get(meal.id);
    if (!photoRow) throw new HttpError(400, 'no base photo to transform — add a photo to this meal first');
    const basePath = path.join(PHOTO_DIR, photoRow.filename);
    if (!fs.existsSync(basePath)) throw new HttpError(404, 'base photo file missing on disk');
    inputImage = { buffer: fs.readFileSync(basePath), mime: mimeFromName(photoRow.filename), filename: photoRow.filename };
  }

  const finalPrompt = (prompt && String(prompt).trim()) || comfy.buildPrompt(meal.name);
  let result;
  try {
    result = await comfy.generateImage({ prompt: finalPrompt, mode, inputImage });
  } catch (err) {
    throw new HttpError(502, 'image generation failed', err.message);
  }

  const ext = (result.filename.split('.').pop() || 'png').toLowerCase();
  try {
    const saved = saveMealPhoto(meal.id, result.buffer, ext);
    return { ...saved, prompt: finalPrompt, mode };
  } catch (err) {
    throw new HttpError(500, 'failed to save generated image', err.message);
  }
}

module.exports = {
  PHOTO_DIR, MAX_PHOTO_BYTES, MIME_EXT,
  mimeFromName, saveMealPhoto, generateMealImage, HttpError,
};
