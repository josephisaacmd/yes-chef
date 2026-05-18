// yes-chef: Your Smart Menu Planner. Meal picker, planner, history & AI photo analysis.
// Express + SQLite + plain-HTML SPA. Single process; data lives under DATA_DIR.

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const bcrypt = require('bcryptjs');

const { requireAuth }  = require('./middleware/auth');
const { agentAuth }    = require('./middleware/agent-auth');
const buildAuthRouter  = require('./routes/auth');
const buildOAuthRouter = require('./routes/oauth');
const mealsRouter      = require('./routes/meals');
const tagsRouter       = require('./routes/tags');
const entriesRouter    = require('./routes/entries');
const agentRouter      = require('./routes/agent');

const PORT           = parseInt(process.env.PORT || '3000', 10);
const DATA_DIR       = process.env.DATA_DIR || path.join(__dirname, 'data');
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-only-not-secret';
const APP_PASSWORD   = process.env.APP_PASSWORD || 'changeme';
const SECURE_COOKIES = String(process.env.SECURE_COOKIES || 'false') === 'true';

fs.mkdirSync(path.join(DATA_DIR, 'sessions'), { recursive: true });

const passwordHash = bcrypt.hashSync(APP_PASSWORD, 10);
if (APP_PASSWORD === 'changeme') {
  console.warn('⚠️  APP_PASSWORD is the default. Set it in .env before exposing this app.');
}

const app = express();

// We're behind Cloudflare Tunnel / reverse proxy. Trust the first hop so
// Secure cookies + req.ip work correctly.
app.set('trust proxy', 1);

app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: false }));

app.use(session({
  store: new FileStore({
    path: path.join(DATA_DIR, 'sessions'),
    retries: 1,
    logFn: () => {},
  }),
  name: 'yes_chef_sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: SECURE_COOKIES,
    maxAge: 400 * 24 * 60 * 60 * 1000, // 400 days — browser-enforced maximum
  },
}));

// Public endpoints
app.use('/auth',  buildAuthRouter({ passwordHash }));
app.use('/auth',  buildOAuthRouter()); // adds /auth/google and /auth/google/callback if enabled

// Public static assets that the login page needs.
app.get('/login',     (_req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/style.css', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'style.css')));

// Agent API: bearer-token OR session auth. Mounted before requireAuth
// so that token-only requests don't get bounced to /login.
app.use('/api/v1/agent', agentAuth, agentRouter);

// Everything below requires browser login.
app.use(requireAuth);

app.use('/api/meals',   mealsRouter);
app.use('/api/tags',    tagsRouter);
app.use('/api/entries', entriesRouter);

// Authenticated static serving of meal photos. Filenames are random UUIDs we
// generated server-side, but still validate to block any path traversal.
app.use('/photos', express.static(path.join(DATA_DIR, 'photos'), {
  fallthrough: true,
  index: false,
  maxAge: '7d',
}));

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Error handler — keep error messages out of HTML responses.
app.use((err, req, res, _next) => {
  console.error(err);
  if (req.path.startsWith('/api/')) return res.status(500).json({ error: 'server error' });
  res.status(500).send('Server error');
});

app.listen(PORT, () => {
  console.log(`yes-chef listening on :${PORT}  (data in ${DATA_DIR})`);
});
