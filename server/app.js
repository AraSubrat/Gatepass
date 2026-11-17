const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { open } = require('./db');
const { createNotifier } = require('./notify');
const { hashPassword, verifyPassword, HttpError, str, normPhone } = require('./util');

const SESSION_DAYS = 60;

function createApp({ dbFile = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'gatepass.db') } = {}) {
  const db = open(dbFile);
  const notify = createNotifier(db);
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '100kb' }));

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'",
    });
    next();
  });

  // CORS for the native Android/iOS apps (their pages are served from capacitor://localhost or https://localhost).
  // They authenticate with a bearer token, never cookies, so allowing these origins does not expose cookie sessions.
  const corsOrigins = new Set(['capacitor://localhost', 'https://localhost', 'http://localhost',
    ...(process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)]);
  app.use('/api', (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && corsOrigins.has(origin)) {
      res.set({
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin',
      });
      if (req.method === 'OPTIONS') return res.sendStatus(204);
    }
    next();
  });

  // CSRF defence: state-changing API calls must be JSON (browsers can't send that cross-site without CORS).
  app.use('/api', (req, res, next) => {
    if (!['GET', 'HEAD', 'DELETE'].includes(req.method) && !req.is('application/json')) {
      return res.status(415).json({ error: 'Requests must be JSON' });
    }
    next();
  });

  // ---- Sessions ----
  const cookieName = 'gp_session';
  const secureCookie = process.env.COOKIE_SECURE === '1';

  // Web uses an HttpOnly cookie; the native apps send "Authorization: Bearer <token>".
  // EventSource can't set headers, so the live-updates stream also accepts ?token=.
  function readToken(req) {
    const bearer = (req.headers.authorization || '').match(/^Bearer ([a-f0-9]{64})$/);
    if (bearer) return bearer[1];
    if (req.path === '/events' && /^[a-f0-9]{64}$/.test(req.query.token || '')) return req.query.token;
    const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${cookieName}=([a-f0-9]{64})`));
    return m ? m[1] : null;
  }

  function startSession(res, userId) {
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + SESSION_DAYS * 864e5);
    db.run('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)', token, userId, expires.toISOString());
    res.setHeader('Set-Cookie',
      `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secureCookie ? '; Secure' : ''}`);
    return token;
  }

  app.use('/api', (req, res, next) => {
    const token = readToken(req);
    if (token) {
      const u = db.get(`
        SELECT u.id, u.name, u.phone, u.role, u.status, u.flat_id, f.label AS flat
        FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN flats f ON f.id = u.flat_id
        WHERE s.token = ? AND s.expires_at > ?`, token, new Date().toISOString());
      if (u && u.status === 'active') { req.user = u; req.token = token; }
    }
    next();
  });

  const auth = (...roles) => (req, res, next) => {
    if (!req.user) return next(new HttpError(401, 'Please log in'));
    if (roles.length && !roles.includes(req.user.role)) return next(new HttpError(403, 'Not allowed'));
    next();
  };

  // Simple in-memory brute-force protection for login.
  const attempts = new Map();
  function throttle(key) {
    const now = Date.now();
    const a = attempts.get(key) || { n: 0, t: now };
    if (now - a.t > 15 * 60e3) { a.n = 0; a.t = now; }
    a.n += 1;
    attempts.set(key, a);
    if (a.n > 10) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
  }

  // ---- Public / auth endpoints ----
  app.get('/api/config', (req, res) => {
    res.json({
      society: process.env.SOCIETY_NAME || 'Our Society',
      pushKey: notify.publicKey,
      nativePush: notify.nativePushEnabled,
    });
  });

  app.get('/api/flats', (req, res) => {
    res.json(db.all('SELECT id, label FROM flats ORDER BY label'));
  });

  app.post('/api/auth/login', (req, res) => {
    const phone = normPhone(str(req.body, 'phone', { max: 20 }));
    const password = str(req.body, 'password', { max: 200 });
    throttle(`${req.ip}|${phone}`);
    const u = db.get('SELECT * FROM users WHERE phone = ?', phone);
    if (!u || !verifyPassword(password, u.password_hash)) throw new HttpError(401, 'Wrong phone number or password');
    if (u.status === 'pending') throw new HttpError(403, 'Your account is waiting for approval by the committee');
    if (u.status === 'disabled') throw new HttpError(403, 'Your account has been disabled');
    attempts.delete(`${req.ip}|${phone}`);
    const token = startSession(res, u.id);
    // Native apps ask for the token in the body (they can't use the cookie); the web never receives it.
    res.json(req.body.native ? { ok: true, token } : { ok: true });
  });

  app.post('/api/auth/register', (req, res) => {
    const name = str(req.body, 'name', { max: 80 });
    const phone = normPhone(str(req.body, 'phone', { max: 20 }));
    const password = str(req.body, 'password', { max: 200 });
    const flatId = Number(req.body.flat_id);
    if (!/^\+?\d{10,13}$/.test(phone)) throw new HttpError(400, 'Enter a valid phone number');
    if (password.length < 6) throw new HttpError(400, 'Password must be at least 6 characters');
    if (!db.get('SELECT id FROM flats WHERE id = ?', flatId)) throw new HttpError(400, 'Choose your flat');
    if (db.get('SELECT id FROM users WHERE phone = ?', phone)) throw new HttpError(409, 'This phone number is already registered');
    db.run("INSERT INTO users (name, phone, password_hash, role, flat_id, status) VALUES (?, ?, ?, 'resident', ?, 'pending')",
      name, phone, hashPassword(password), flatId);
    notify.toUsers(notify.admins(), 'admin', {}, {
      title: 'New resident sign-up', body: `${name} is waiting for approval`, url: '/#/admin',
    });
    res.status(201).json({ ok: true, message: 'Registered. The committee will approve your account shortly.' });
  });

  app.post('/api/auth/logout', (req, res) => {
    if (req.token) db.run('DELETE FROM sessions WHERE token = ?', req.token);
    res.setHeader('Set-Cookie', `${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    res.json({ ok: true });
  });

  app.get('/api/me', auth(), (req, res) => res.json(req.user));

  app.post('/api/me/password', auth(), (req, res) => {
    const current = str(req.body, 'current', { max: 200 });
    const next = str(req.body, 'password', { max: 200 });
    if (next.length < 6) throw new HttpError(400, 'Password must be at least 6 characters');
    const u = db.get('SELECT password_hash FROM users WHERE id = ?', req.user.id);
    if (!verifyPassword(current, u.password_hash)) throw new HttpError(400, 'Current password is wrong');
    db.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(next), req.user.id);
    db.run('DELETE FROM sessions WHERE user_id = ? AND token != ?', req.user.id, req.token);
    res.json({ ok: true });
  });

  // ---- Live updates & push ----
  app.get('/api/events', auth(), (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.write('retry: 5000\n\n');
    const unsubscribe = notify.subscribe(req.user.id, res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25e3);
    req.on('close', () => { clearInterval(ping); unsubscribe(); });
  });

  app.post('/api/push/subscribe', auth(), (req, res) => {
    const { endpoint, keys } = req.body || {};
    if (typeof endpoint !== 'string' || !endpoint.startsWith('https://') || !keys?.p256dh || !keys?.auth) {
      throw new HttpError(400, 'Invalid subscription');
    }
    db.run(`INSERT INTO push_subscriptions (endpoint, user_id, keys) VALUES (?, ?, ?)
            ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, keys = excluded.keys`,
      endpoint, req.user.id, JSON.stringify({ p256dh: keys.p256dh, auth: keys.auth }));
    res.json({ ok: true });
  });

  app.post('/api/push/unsubscribe', auth(), (req, res) => {
    db.run('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?', String(req.body?.endpoint || ''), req.user.id);
    res.json({ ok: true });
  });

  // Native app push (Firebase Cloud Messaging covers both Android and iOS).
  app.post('/api/push/native', auth(), (req, res) => {
    const token = str(req.body, 'token', { max: 4096 });
    const platform = ['android', 'ios'].includes(req.body.platform) ? req.body.platform : 'android';
    db.run(`INSERT INTO native_push_tokens (token, user_id, platform) VALUES (?, ?, ?)
            ON CONFLICT(token) DO UPDATE SET user_id = excluded.user_id, platform = excluded.platform`, token, req.user.id, platform);
    res.json({ ok: true });
  });

  app.post('/api/push/native/remove', auth(), (req, res) => {
    db.run('DELETE FROM native_push_tokens WHERE token = ? AND user_id = ?', String(req.body?.token || ''), req.user.id);
    res.json({ ok: true });
  });

  // ---- Feature routes ----
  const ctx = { db, notify, auth };
  app.use('/api', require('./routes/gate')(ctx));
  app.use('/api', require('./routes/community')(ctx));
  app.use('/api', require('./routes/amenities')(ctx));
  app.use('/api', require('./routes/helpdesk')(ctx));
  app.use('/api', require('./routes/admin')(ctx));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // ---- Static front-end ----
  app.use(express.static(path.join(__dirname, '..', 'public'), {
    setHeaders: (res, file) => {
      if (file.endsWith('sw.js') || file.endsWith('.html')) res.set('Cache-Control', 'no-cache');
    },
  }));
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong' : err.message });
  });

  // Make sure the first committee admin exists.
  function ensureAdmin(phone, password, name = 'Admin') {
    phone = normPhone(phone);
    if (db.get("SELECT id FROM users WHERE role = 'admin'")) return false;
    db.run("INSERT INTO users (name, phone, password_hash, role, status) VALUES (?, ?, ?, 'admin', 'active')",
      name, phone, hashPassword(password));
    return true;
  }

  return { app, db, notify, ensureAdmin };
}

module.exports = { createApp };
