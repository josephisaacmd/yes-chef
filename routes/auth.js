// Password-based login. Compares against a bcrypt hash computed at server boot
// from APP_PASSWORD so the plaintext is never written to disk.

const express = require('express');
const bcrypt = require('bcryptjs');

const MAX_ATTEMPTS  = 5;
const LOCKOUT_MS    = 24 * 60 * 60 * 1000; // 24 hours

// Map<ip, { count: number, lockedUntil: number|null }>
const loginAttempts = new Map();

function getAttemptRecord(ip) {
  if (!loginAttempts.has(ip)) loginAttempts.set(ip, { count: 0, lockedUntil: null });
  return loginAttempts.get(ip);
}

function isLocked(record) {
  if (!record.lockedUntil) return false;
  if (Date.now() < record.lockedUntil) return true;
  // Lock has expired — reset automatically.
  record.count = 0;
  record.lockedUntil = null;
  return false;
}

module.exports = function buildAuthRouter({ passwordHash }) {
  const router = express.Router();

  router.post('/login', async (req, res) => {
    const ip     = req.ip;
    const record = getAttemptRecord(ip);

    if (isLocked(record)) {
      const retryAfter = Math.ceil((record.lockedUntil - Date.now()) / 1000 / 60);
      return res.status(429).json({
        error: `Too many failed attempts. Try again in ${retryAfter} minute${retryAfter === 1 ? '' : 's'}.`,
      });
    }

    const pw = (req.body?.password || '').toString();
    if (!pw) return res.status(400).json({ error: 'password required' });

    const ok = await bcrypt.compare(pw, passwordHash);

    if (!ok) {
      record.count += 1;
      if (record.count >= MAX_ATTEMPTS) {
        record.lockedUntil = Date.now() + LOCKOUT_MS;
        console.warn(`[auth] IP ${ip} locked out after ${MAX_ATTEMPTS} failed login attempts.`);
        return res.status(429).json({
          error: `Too many failed attempts. Account locked for 24 hours.`,
        });
      }
      const remaining = MAX_ATTEMPTS - record.count;
      return res.status(401).json({
        error: `Wrong password. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`,
      });
    }

    // Successful login — clear the failure record.
    loginAttempts.delete(ip);
    req.session.user = { method: 'password', name: 'household' };
    res.json({ ok: true });
  });

  router.post('/logout', (req, res) => {
    req.session.destroy(() => res.json({ ok: true }));
  });

  router.get('/me', (req, res) => {
    res.json({ user: req.session?.user || null });
  });

  return router;
};
