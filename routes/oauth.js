// Optional Google OAuth 2.0 (Authorization Code flow).
// Only wired up if GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET are set.
//
// Setup:
//   1. Google Cloud Console -> APIs & Services -> Credentials -> Create OAuth client ID
//      Type: Web application
//      Authorized redirect URI: <PUBLIC_BASE_URL>/auth/google/callback
//   2. Put the client id/secret into .env, plus ALLOWED_EMAILS (comma-separated).
//   3. Restart container.

const express = require('express');
const crypto = require('crypto');

module.exports = function buildOAuthRouter() {
  const {
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    PUBLIC_BASE_URL,
    ALLOWED_EMAILS = '',
  } = process.env;

  const enabled = !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && PUBLIC_BASE_URL);
  const router = express.Router();

  router.get('/status', (_req, res) => res.json({ enabled }));
  if (!enabled) return router;

  const allowed = new Set(
    ALLOWED_EMAILS.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  );
  const redirectUri = `${PUBLIC_BASE_URL.replace(/\/$/, '')}/auth/google/callback`;

  router.get('/google', (req, res) => {
    const state = crypto.randomBytes(16).toString('hex');
    req.session.oauthState = state;
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', GOOGLE_CLIENT_ID);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('state', state);
    url.searchParams.set('prompt', 'select_account');
    res.redirect(url.toString());
  });

  router.get('/google/callback', async (req, res) => {
    try {
      const { code, state } = req.query;
      if (!code || !state || state !== req.session.oauthState) {
        return res.status(400).send('OAuth state mismatch');
      }
      delete req.session.oauthState;

      // Exchange code for tokens
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }),
      });
      if (!tokenRes.ok) {
        const text = await tokenRes.text();
        return res.status(500).send('Token exchange failed: ' + text);
      }
      const tokens = await tokenRes.json();

      // Decode the id_token payload to get email (no signature verification here;
      // we trust the TLS channel to Google. Sufficient for a 2-person app.)
      const payload = JSON.parse(
        Buffer.from(tokens.id_token.split('.')[1], 'base64').toString('utf8')
      );
      const email = (payload.email || '').toLowerCase();
      if (!email || (allowed.size && !allowed.has(email))) {
        return res.status(403).send(`Sign-in not allowed for ${email}.`);
      }

      req.session.user = { method: 'google', name: payload.name || email, email };
      res.redirect('/');
    } catch (err) {
      console.error('OAuth callback error:', err);
      res.status(500).send('OAuth error');
    }
  });

  return router;
};
