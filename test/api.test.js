const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server/app');
const { localNow, addDays } = require('../server/util');

let server, base, db;

before(async () => {
  const made = createApp({ dbFile: ':memory:' });
  db = made.db;
  made.ensureAdmin('9000000000', 'adminpass', 'Admin');
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

// Tiny cookie-keeping client per user.
function client() {
  let cookie = '';
  return async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'content-type': 'application/json', cookie },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  };
}

const admin = client();
const guard = client();
const alice = client(); // resident of A-101
const bob = client();   // resident of A-102
let flats;

test('admin sets up flats, approves a sign-up and creates a guard', async () => {
  assert.equal((await admin('POST', '/api/auth/login', { phone: '+91 90000 00000', password: 'adminpass' })).status, 200);
  const add = await admin('POST', '/api/admin/flats', { labels: 'A-101..A-104\nB-201, B-202' });
  assert.deepEqual(add.data, { added: 6, skipped: 0 });
  flats = Object.fromEntries((await admin('GET', '/api/flats')).data.map((f) => [f.label, f.id]));

  const reg = await alice('POST', '/api/auth/register', { name: 'Alice', phone: '9111111111', password: 'secret1', flat_id: flats['A-101'] });
  assert.equal(reg.status, 201);
  assert.equal((await alice('POST', '/api/auth/login', { phone: '9111111111', password: 'secret1' })).status, 403, 'pending users cannot log in');

  const pending = (await admin('GET', '/api/admin/users?status=pending')).data;
  assert.equal(pending.length, 1);
  assert.equal((await admin('PATCH', `/api/admin/users/${pending[0].id}`, { status: 'active' })).status, 200);
  assert.equal((await alice('POST', '/api/auth/login', { phone: '9111111111', password: 'secret1' })).status, 200);

  const g = await admin('POST', '/api/admin/users', { name: 'Ramesh', phone: '9222222222', role: 'guard' });
  assert.equal(g.status, 201);
  assert.equal((await guard('POST', '/api/auth/login', { phone: '9222222222', password: g.data.password })).status, 200);

  await admin('POST', '/api/admin/users', { name: 'Bob', phone: '9333333333', role: 'resident', flat_id: flats['A-102'], password: 'bobpass' });
  assert.equal((await bob('POST', '/api/auth/login', { phone: '9333333333', password: 'bobpass' })).status, 200);
});

test('non-JSON writes are rejected (CSRF guard)', async () => {
  const res = await fetch(`${base}/api/auth/login`, { method: 'POST', body: 'phone=1', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(res.status, 415);
});

test('gate flow: guard logs visitor, resident approves, guard marks exit', async () => {
  const v = await guard('POST', '/api/visitors', { flat_id: flats['A-101'], name: 'Courier', purpose: 'delivery', vehicle: 'ka01ab1234' });
  assert.equal(v.status, 201);
  assert.equal(v.data.status, 'pending');
  assert.equal(v.data.vehicle, 'KA01AB1234');
  assert.equal(v.data.residents_on_app, 1);

  assert.equal((await bob('POST', `/api/visitors/${v.data.id}/decision`, { decision: 'approve' })).status, 404, 'other flats cannot decide');
  assert.equal((await bob('GET', '/api/visitors?scope=active')).data.length, 0, 'residents only see their own flat');

  const ok = await alice('POST', `/api/visitors/${v.data.id}/decision`, { decision: 'approve' });
  assert.equal(ok.data.status, 'inside');
  assert.equal((await alice('POST', `/api/visitors/${v.data.id}/decision`, { decision: 'deny' })).status, 409);

  const out = await guard('POST', `/api/visitors/${v.data.id}/status`, { action: 'exit' });
  assert.equal(out.data.status, 'exited');
  assert.ok(out.data.out_at);

  const log = await alice('GET', '/api/visitors');
  assert.equal(log.data.length, 1, 'visitor appears in today\'s log');
  assert.equal((await alice('POST', '/api/visitors', { flat_id: flats['A-101'], name: 'x' })).status, 403, 'residents cannot log visitors');
});

test('pre-approved gate pass is single use', async () => {
  const p = await alice('POST', '/api/passes', { guest_name: 'Grandma' });
  assert.equal(p.status, 201);
  assert.match(p.data.code, /^\d{6}$/);
  const v = await guard('POST', '/api/passes/verify', { code: p.data.code });
  assert.equal(v.status, 201);
  assert.equal(v.data.status, 'inside');
  assert.equal(v.data.flat, 'A-101');
  assert.equal((await guard('POST', '/api/passes/verify', { code: p.data.code })).status, 409);
  assert.equal((await guard('POST', '/api/passes/verify', { code: '000000' === p.data.code ? '111111' : '000000' })).status, 404);
});

test('amenity booking prevents double booking and enforces fair use', async () => {
  const a = await admin('POST', '/api/amenities', { name: 'Clubhouse', open_time: '06:00', close_time: '22:00', slot_minutes: 120, max_days_ahead: 7 });
  assert.equal(a.status, 201);
  const date = addDays(localNow().date, 1);
  const slots = (await alice('GET', `/api/amenities/${a.data.id}/slots?date=${date}`)).data.slots;
  assert.equal(slots.length, 8);
  assert.equal((await alice('POST', '/api/bookings', { amenity_id: a.data.id, date, start_time: '08:00' })).status, 201);
  assert.equal((await bob('POST', '/api/bookings', { amenity_id: a.data.id, date, start_time: '08:00' })).status, 409, 'slot taken');
  assert.equal((await alice('POST', '/api/bookings', { amenity_id: a.data.id, date, start_time: '10:00' })).status, 409, 'one per flat per day');
  assert.equal((await alice('POST', '/api/bookings', { amenity_id: a.data.id, date, start_time: '09:00' })).status, 400, 'not a slot start');
  assert.equal((await alice('POST', '/api/bookings', { amenity_id: a.data.id, date: addDays(date, 30), start_time: '08:00' })).status, 400, 'too far ahead');

  const view = (await bob('GET', `/api/amenities/${a.data.id}/slots?date=${date}`)).data.slots.find((s) => s.start === '08:00');
  assert.equal(view.booked, true);
  assert.equal(view.booking_id, null, 'others cannot see/cancel booking id');

  const mine = (await alice('GET', '/api/bookings')).data;
  assert.equal(mine.length, 1);
  assert.equal((await bob('DELETE', `/api/bookings/${mine[0].id}`)).status, 404);
  assert.equal((await alice('DELETE', `/api/bookings/${mine[0].id}`)).status, 200);
  assert.equal((await bob('POST', '/api/bookings', { amenity_id: a.data.id, date, start_time: '08:00' })).status, 201, 'freed slot can be rebooked');
});

test('forum: residents discuss, only admins post notices', async () => {
  assert.equal((await alice('POST', '/api/posts', { kind: 'notice', title: 'x', body: 'y' })).status, 403);
  const n = await admin('POST', '/api/posts', { kind: 'notice', title: 'Water shutdown', body: 'Tomorrow 10-12', pinned: true });
  assert.equal(n.status, 201);
  const d = await alice('POST', '/api/posts', { kind: 'discussion', title: 'Lost cat', body: 'Grey, answers to Milo' });
  await bob('POST', `/api/posts/${d.data.id}/comments`, { body: 'Saw it near B tower' });
  const post = (await alice('GET', `/api/posts/${d.data.id}`)).data;
  assert.equal(post.comments.length, 1);
  const list = (await bob('GET', '/api/posts')).data;
  assert.equal(list[0].title, 'Water shutdown', 'pinned notice first');
  assert.equal((await bob('DELETE', `/api/posts/${d.data.id}`)).status, 403);
  assert.equal((await guard('GET', '/api/posts')).status, 200);
});

test('helpdesk: resident raises, admin resolves', async () => {
  const c = await alice('POST', '/api/complaints', { category: 'Lift', description: 'Lift A stuck on 3rd floor' });
  assert.equal(c.status, 201);
  assert.equal((await bob('GET', '/api/complaints')).data.length, 0);
  assert.equal((await admin('GET', '/api/complaints?all=1')).data.length, 1);
  await admin('PATCH', `/api/complaints/${c.data.id}`, { status: 'resolved', admin_note: 'Technician fixed it' });
  const mine = (await alice('GET', '/api/complaints')).data;
  assert.equal(mine[0].status, 'resolved');
  assert.equal(mine[0].admin_note, 'Technician fixed it');
});

test('disabled users are logged out immediately', async () => {
  const bobId = db.get("SELECT id FROM users WHERE phone = '9333333333'").id;
  await admin('PATCH', `/api/admin/users/${bobId}`, { status: 'disabled' });
  assert.equal((await bob('GET', '/api/me')).status, 401);
});

test('native apps: bearer token login, CORS preflight and token-authenticated SSE', async () => {
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'capacitor://localhost' },
    body: JSON.stringify({ phone: '9111111111', password: 'secret1', native: true }),
  });
  assert.equal(login.headers.get('access-control-allow-origin'), 'capacitor://localhost');
  const { token } = await login.json();
  assert.match(token, /^[a-f0-9]{64}$/);

  const web = await (await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: '9111111111', password: 'secret1' }),
  })).json();
  assert.equal(web.token, undefined, 'web login never exposes the token to JavaScript');

  const pre = await fetch(`${base}/api/me`, { method: 'OPTIONS', headers: { origin: 'https://localhost', 'access-control-request-headers': 'authorization' } });
  assert.equal(pre.status, 204);
  const evil = await fetch(`${base}/api/me`, { headers: { origin: 'https://evil.example', authorization: `Bearer ${token}` } });
  assert.equal(evil.headers.get('access-control-allow-origin'), null, 'unknown origins get no CORS headers');

  const me = await (await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${token}` } })).json();
  assert.equal(me.name, 'Alice');
  assert.equal((await fetch(`${base}/api/me?token=${token}`)).status, 401, 'query token only accepted for the event stream');

  const ctrl = new AbortController();
  const sse = await fetch(`${base}/api/events?token=${token}`, { signal: ctrl.signal });
  assert.equal(sse.status, 200);
  assert.match(sse.headers.get('content-type'), /text\/event-stream/);
  ctrl.abort();

  const reg = await fetch(`${base}/api/push/native`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ token: 'fcm-device-token-123', platform: 'android' }),
  });
  assert.equal(reg.status, 200);
  assert.equal(db.get('SELECT platform FROM native_push_tokens WHERE token = ?', 'fcm-device-token-123').platform, 'android');
});

test('screens are revalidated on every load so app updates reach phones at once', async () => {
  for (const f of ['/', '/app.js', '/styles.css']) {
    assert.equal((await fetch(base + f)).headers.get('cache-control'), 'no-cache', f);
  }
  assert.equal((await fetch(`${base}/download/gatepass.apk`)).status, 404, 'no APK uploaded yet');
  assert.equal((await (await fetch(`${base}/api/config`)).json()).androidApp, false);
});
