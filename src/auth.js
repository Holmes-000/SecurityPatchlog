const crypto = require('crypto');

const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [alg, saltHex, hashHex] = String(stored).split(':');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

// Used to make login timing the same whether or not the email exists
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 10) {
    throw new HttpError(400, 'Password must be at least 10 characters.');
  }
  if (password.length > 200) throw new HttpError(400, 'Password is too long.');
}

/** Ties a session to the current password, so a password change or reset logs out old sessions. */
function passwordVersion(user) {
  return sha256(user.password_hash).slice(0, 16);
}

function signToken(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyToken(token, secret) {
  if (typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', secret).update(body).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function issueSession(user, secret) {
  return signToken(
    { uid: user.id, pv: passwordVersion(user), exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS },
    secret
  );
}

function newApiKey() {
  return `sdk_${crypto.randomBytes(24).toString('base64url')}`;
}

function bearer(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function makeAuthMiddleware(db, getSecret) {
  const findUser = db.prepare('SELECT * FROM users WHERE id = ?');

  function requireUser(req, res, next) {
    const payload = verifyToken(bearer(req), getSecret());
    const user = payload && findUser.get(payload.uid);
    if (!user || user.disabled || passwordVersion(user) !== payload.pv) {
      return next(new HttpError(401, 'Not signed in.'));
    }
    req.user = user;
    next();
  }

  function requireAdmin(req, res, next) {
    if (!req.user || req.user.role !== 'admin') return next(new HttpError(403, 'Admins only.'));
    next();
  }

  const findProjectByKey = db.prepare('SELECT * FROM projects WHERE api_key_hash = ?');
  function requireProjectKey(req, res, next) {
    const key = bearer(req);
    const project = key && findProjectByKey.get(sha256(key));
    if (!project) return next(new HttpError(401, 'Invalid or missing project API key.'));
    req.project = project;
    next();
  }

  return { requireUser, requireAdmin, requireProjectKey };
}

/** Simple in-memory fixed-window limiter, keyed by IP. */
function rateLimit({ windowMs, max }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  }, windowMs).unref();

  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip;
    let entry = hits.get(key);
    if (!entry || entry.reset < now) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(key, entry);
    }
    entry.count++;
    if (entry.count > max) {
      res.set('Retry-After', String(Math.ceil((entry.reset - now) / 1000)));
      return next(new HttpError(429, 'Too many attempts. Try again later.'));
    }
    next();
  };
}

module.exports = {
  HttpError,
  sha256,
  hashPassword,
  verifyPassword,
  validatePassword,
  DUMMY_HASH,
  issueSession,
  newApiKey,
  makeAuthMiddleware,
  rateLimit,
};
