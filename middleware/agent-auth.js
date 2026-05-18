// Accepts either a logged-in browser session OR an `Authorization: Bearer <token>`
// header where the token is in the comma-separated AGENT_API_TOKENS env var.
// Use this middleware in front of routes that external agents need to call.

const TOKENS = (process.env.AGENT_API_TOKENS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const ENABLED = TOKENS.length > 0;

function agentAuth(req, res, next) {
  if (req.session?.user) {
    req.auth = { kind: 'session' };
    return next();
  }
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (m && ENABLED && TOKENS.includes(m[1])) {
    req.auth = { kind: 'agent', token_prefix: m[1].slice(0, 6) };
    return next();
  }
  return res.status(401).json({ error: 'unauthenticated' });
}

module.exports = { agentAuth, agentAuthEnabled: () => ENABLED };
