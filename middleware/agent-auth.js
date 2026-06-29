// Accepts either a logged-in browser session OR an `Authorization: Bearer <token>`
// header. Valid tokens come from two places:
//   1. the comma-separated AGENT_API_TOKENS env var (legacy / bootstrap), and
//   2. tokens created at runtime via the Settings UI (stored hashed in the DB).
// Use this middleware in front of routes that external agents need to call.

const { verifyAgentToken, agentTokenCount } = require('../db');

// Strip surrounding single/double quotes and whitespace from a value.
// docker-compose's `env_file` parser (unlike dotenv) does NOT strip quotes,
// so AGENT_API_TOKENS="abc" arrives as the literal string `"abc"` inside the
// container. Be defensive so a quoted .env value still works.
function clean(s) {
  return s.trim().replace(/^['"]+|['"]+$/g, '').trim();
}

const RAW = clean(process.env.AGENT_API_TOKENS || '');
const ENV_TOKENS = RAW.split(',').map(clean).filter(Boolean);

// One-line startup log so misconfigured tokens surface immediately. Never
// prints the full secret — only the count and a 6-char prefix of each.
const dbCount = (() => { try { return agentTokenCount(); } catch { return 0; } })();
if (ENV_TOKENS.length) {
  console.log(`[agent-auth] ${ENV_TOKENS.length} env token(s) loaded: ${ENV_TOKENS.map(t => t.slice(0, 6) + '…').join(', ')}`);
}
console.log(`[agent-auth] ${dbCount} token(s) managed in DB (create/delete from Settings).`);
if (!ENV_TOKENS.length && dbCount === 0) {
  console.log('[agent-auth] no tokens configured yet — add one under Settings → Agent API tokens.');
}

function agentAuth(req, res, next) {
  if (req.session?.user) {
    req.auth = { kind: 'session' };
    return next();
  }
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (m) {
    const token = m[1];
    // 1. env tokens (bootstrap)
    if (ENV_TOKENS.includes(token)) {
      req.auth = { kind: 'agent', source: 'env', token_prefix: token.slice(0, 6) };
      return next();
    }
    // 2. DB-managed tokens
    const row = verifyAgentToken(token);
    if (row) {
      req.auth = { kind: 'agent', source: 'db', token_id: row.id, label: row.label, token_prefix: row.token_prefix };
      return next();
    }
  }
  return res.status(401).json({ error: 'unauthenticated' });
}

module.exports = {
  agentAuth,
  agentAuthEnabled: () => ENV_TOKENS.length > 0 || agentTokenCount() > 0,
};
