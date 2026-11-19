const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { openDb, getSetting, setSetting } = require('./db');
const { hashPassword, HttpError } = require('./auth');
const { createApi } = require('./api');

const APP_ROOT = path.resolve(__dirname, '..');

// Load secpatchlog/.env without overriding real environment variables
(function loadEnv() {
  const file = path.join(APP_ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = raw.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m || raw.trim().startsWith('#')) continue;
    let v = m[2].trim();
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
})();

const PORT = Number(process.env.PORT) || 4400;

if (process.env.PUBLIC_URL && !/^https?:\/\/[^/\s]+/i.test(process.env.PUBLIC_URL.trim())) {
  console.warn(`[secpatchlog] PUBLIC_URL "${process.env.PUBLIC_URL}" is not an http(s) URL; ignoring it.`);
}
const db = openDb(path.resolve(APP_ROOT, process.env.DB_PATH || 'data/security.db'));

// Session secret: env wins, otherwise a generated one persisted in the DB
let secret = process.env.SESSION_SECRET;
if (!secret) {
  secret = getSetting(db, 'session_secret');
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    setSetting(db, 'session_secret', secret);
  }
}

// Optional bootstrap admin from env
if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
  const n = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (n === 0) {
    if (process.env.ADMIN_PASSWORD.length < 10) {
      console.warn('[secpatchlog] ADMIN_PASSWORD must be at least 10 characters; skipping admin bootstrap.');
    } else {
      db.prepare("INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, 'admin')").run(
        process.env.ADMIN_EMAIL.trim().toLowerCase(),
        process.env.ADMIN_NAME || 'Admin',
        hashPassword(process.env.ADMIN_PASSWORD)
      );
      console.log(`[secpatchlog] created admin ${process.env.ADMIN_EMAIL}`);
    }
  }
}

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy':
      "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
  });
  next();
});

app.use('/api', express.json({ limit: '20mb' }));
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.use('/api', createApi(db, () => secret));
app.use('/api', (req, res, next) => next(new HttpError(404, 'Not found.')));

// no-cache = always revalidate (cheap 304 via ETag), so users get new UI code right after an update
app.use(
  express.static(path.join(APP_ROOT, 'public'), {
    index: 'index.html',
    setHeaders: (res) => res.set('Cache-Control', 'no-cache'),
  })
);

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') err = new HttpError(413, 'Payload too large.');
  if (err.type === 'entity.parse.failed') err = new HttpError(400, 'Body is not valid JSON.');
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Internal server error.' : err.message });
});

app.listen(PORT, () => {
  console.log(`[secpatchlog] listening on http://localhost:${PORT}`);
});
