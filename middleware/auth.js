// Auth middleware: gates the API + the SPA behind a logged-in session.
// Login can happen two ways:
//   1. Shared password (always on).
//   2. Google OAuth (enabled if GOOGLE_CLIENT_ID is set; see routes/oauth.js).

function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  // For API calls AND static photo requests, return a real 401. Image tags
  // would otherwise follow a 302→/login and render the HTML as an invisible
  // "broken" image. A 401 makes the browser show a proper broken-image icon
  // (or trigger the onerror handler in our client).
  if (req.path.startsWith('/api/') || req.path.startsWith('/photos/')) {
    return res.status(401).json({ error: 'unauthenticated' });
  }
  return res.redirect('/login');
}

module.exports = { requireAuth };
