// Auth middleware: gates the API + the SPA behind a logged-in session.
// Login can happen two ways:
//   1. Shared password (always on).
//   2. Google OAuth (enabled if GOOGLE_CLIENT_ID is set; see routes/oauth.js).

function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  // For API calls, return JSON 401; for HTML page loads, redirect to /login.
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'unauthenticated' });
  }
  return res.redirect('/login');
}

module.exports = { requireAuth };
