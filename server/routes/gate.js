const crypto = require('node:crypto');
const express = require('express');
const { HttpError, str, normPhone, localNow, isDate, addDays } = require('../util');

const PURPOSES = ['guest', 'delivery', 'cab', 'service', 'other'];
const PURPOSE_LABEL = { guest: 'Guest', delivery: 'Delivery', cab: 'Cab', service: 'Service/Help', other: 'Visitor' };

module.exports = ({ db, notify, auth }) => {
  const r = express.Router();

  const VISITOR_SQL = `
    SELECT v.*, f.label AS flat, d.name AS decided_by_name, g.name AS logged_by_name, p.guest_name AS pass_guest
    FROM visitors v
    JOIN flats f ON f.id = v.flat_id
    LEFT JOIN users d ON d.id = v.decided_by
    LEFT JOIN users g ON g.id = v.logged_by
    LEFT JOIN passes p ON p.id = v.pass_id`;
  const getVisitor = (id) => db.get(`${VISITOR_SQL} WHERE v.id = ?`, id);

  function broadcast(v) {
    notify.toUsers([...notify.guards(), ...notify.residentsOf(v.flat_id)], 'visitor', v);
  }

  // Guard: residents' contacts for a flat, so they can call if nobody responds in the app.
  r.get('/flats/:id/contacts', auth('guard', 'admin'), (req, res) => {
    res.json(db.all("SELECT name, phone FROM users WHERE flat_id = ? AND status = 'active' ORDER BY name", Number(req.params.id)));
  });

  // Guard logs a new visitor -> residents get an approval request.
  r.post('/visitors', auth('guard', 'admin'), (req, res) => {
    const flatId = Number(req.body.flat_id);
    if (!db.get('SELECT id FROM flats WHERE id = ?', flatId)) throw new HttpError(400, 'Choose a valid flat');
    const purpose = PURPOSES.includes(req.body.purpose) ? req.body.purpose : 'guest';
    const name = str(req.body, 'name', { max: 80 });
    const phone = normPhone(str(req.body, 'phone', { required: false, max: 20 })) || null;
    const vehicle = str(req.body, 'vehicle', { required: false, max: 20 })?.toUpperCase() || null;
    const { lastInsertRowid } = db.run(
      "INSERT INTO visitors (flat_id, name, phone, purpose, vehicle, status, logged_by) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
      flatId, name, phone, purpose, vehicle, req.user.id);
    const v = getVisitor(lastInsertRowid);
    const residents = notify.residentsOf(flatId);
    notify.toUsers(residents, 'visitor', v, {
      title: `${PURPOSE_LABEL[purpose]} at the gate`,
      body: `${name} wants to visit ${v.flat}. Tap to approve or deny.`,
      url: '/#/home', tag: `visitor-${v.id}`, requireInteraction: true,
    });
    notify.toUsers(notify.guards(), 'visitor', v);
    res.status(201).json({ ...v, residents_on_app: residents.length });
  });

  // Visitor lists.
  //   scope=active : pending / inside / left at gate (guard console, resident home)
  //   scope=log    : history for a day (default today)
  r.get('/visitors', auth(), (req, res) => {
    const where = [];
    const params = [];
    if (req.user.role === 'resident' || (req.user.role === 'admin' && req.query.mine === '1')) {
      if (!req.user.flat_id) return res.json([]);
      where.push('v.flat_id = ?'); params.push(req.user.flat_id);
    }
    if (req.query.scope === 'active') {
      // Anything still open from the last 24h.
      where.push("v.status IN ('pending','inside','left_at_gate')");
      where.push('v.created_at > ?'); params.push(new Date(Date.now() - 864e5).toISOString());
    } else {
      const date = isDate(req.query.date) ? req.query.date : localNow().date;
      const days = Math.min(Math.max(Number(req.query.days) || 1, 1), 31);
      // created_at is UTC; compare against local-day boundaries using the society TZ offset.
      const offset = tzOffsetMinutes();
      const from = new Date(Date.parse(`${addDays(date, -(days - 1))}T00:00:00Z`) - offset * 60e3).toISOString();
      const to = new Date(Date.parse(`${addDays(date, 1)}T00:00:00Z`) - offset * 60e3).toISOString();
      where.push('v.created_at >= ? AND v.created_at < ?'); params.push(from, to);
    }
    if (req.query.q) {
      where.push('(v.name LIKE ? OR v.phone LIKE ? OR v.vehicle LIKE ? OR f.label LIKE ?)');
      const q = `%${String(req.query.q).slice(0, 40)}%`; params.push(q, q, q, q);
    }
    res.json(db.all(`${VISITOR_SQL} WHERE ${where.join(' AND ') || '1'} ORDER BY v.created_at DESC LIMIT 300`, ...params));
  });

  // Resident approves / denies / asks to leave parcel at the gate.
  r.post('/visitors/:id/decision', auth('resident', 'admin'), (req, res) => {
    const v = getVisitor(Number(req.params.id));
    if (!v || v.flat_id !== req.user.flat_id) throw new HttpError(404, 'Visitor not found');
    if (v.status !== 'pending') throw new HttpError(409, `Already handled by ${v.decided_by_name || 'the gate'}`);
    const map = { approve: 'inside', deny: 'denied', leave_at_gate: 'left_at_gate' };
    const status = map[req.body.decision];
    if (!status) throw new HttpError(400, 'decision must be approve, deny or leave_at_gate');
    const now = new Date().toISOString();
    db.run("UPDATE visitors SET status = ?, decided_by = ?, in_at = ? WHERE id = ? AND status = 'pending'",
      status, req.user.id, status === 'inside' ? now : null, v.id);
    const updated = getVisitor(v.id);
    broadcast(updated);
    res.json(updated);
  });

  // Guard overrides (e.g. resident approved over the phone) or marks exit / collected.
  r.post('/visitors/:id/status', auth('guard', 'admin'), (req, res) => {
    const v = getVisitor(Number(req.params.id));
    if (!v) throw new HttpError(404, 'Visitor not found');
    const now = new Date().toISOString();
    const action = req.body.action;
    if (action === 'allow' && v.status === 'pending') {
      db.run("UPDATE visitors SET status = 'inside', in_at = ?, decided_by = ? WHERE id = ?", now, req.user.id, v.id);
    } else if (action === 'deny' && v.status === 'pending') {
      db.run("UPDATE visitors SET status = 'denied', decided_by = ? WHERE id = ?", req.user.id, v.id);
    } else if (action === 'exit' && (v.status === 'inside' || v.status === 'left_at_gate')) {
      db.run("UPDATE visitors SET status = 'exited', out_at = ? WHERE id = ?", now, v.id);
    } else {
      throw new HttpError(409, `Can't ${action} a visitor who is ${v.status.replace(/_/g, ' ')}`);
    }
    const updated = getVisitor(v.id);
    broadcast(updated);
    if (action === 'allow') {
      notify.toUsers(notify.residentsOf(v.flat_id), 'visitor', updated, {
        title: `${v.name} allowed in`, body: `Security let ${v.name} in for ${v.flat}.`, url: '/#/home', tag: `visitor-${v.id}`,
      });
    }
    res.json(updated);
  });

  // ---- Pre-approved guest passes ----
  r.get('/passes', auth('resident', 'admin'), (req, res) => {
    res.json(db.all(`SELECT * FROM passes WHERE flat_id = ? AND cancelled = 0 AND valid_date >= ?
                     ORDER BY valid_date, created_at DESC`, req.user.flat_id, localNow().date));
  });

  r.post('/passes', auth('resident', 'admin'), (req, res) => {
    if (!req.user.flat_id) throw new HttpError(400, 'Your account is not linked to a flat');
    const guest = str(req.body, 'guest_name', { max: 80 });
    const today = localNow().date;
    const date = isDate(req.body.valid_date) ? req.body.valid_date : today;
    if (date < today || date > addDays(today, 30)) throw new HttpError(400, 'Date must be within the next 30 days');
    let code;
    for (let i = 0; i < 20; i++) {
      const c = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
      if (!db.get('SELECT id FROM passes WHERE code = ? AND valid_date = ? AND cancelled = 0', c, date)) { code = c; break; }
    }
    if (!code) throw new HttpError(503, 'Could not generate a code, try again');
    const { lastInsertRowid } = db.run(
      'INSERT INTO passes (flat_id, created_by, guest_name, code, valid_date) VALUES (?, ?, ?, ?, ?)',
      req.user.flat_id, req.user.id, guest, code, date);
    res.status(201).json(db.get('SELECT * FROM passes WHERE id = ?', lastInsertRowid));
  });

  r.delete('/passes/:id', auth('resident', 'admin'), (req, res) => {
    const out = db.run('UPDATE passes SET cancelled = 1 WHERE id = ? AND flat_id = ? AND used_at IS NULL', Number(req.params.id), req.user.flat_id);
    if (!out.changes) throw new HttpError(404, 'Pass not found or already used');
    res.json({ ok: true });
  });

  // Guard enters the 6-digit code -> visitor is checked in directly.
  r.post('/passes/verify', auth('guard', 'admin'), (req, res) => {
    const code = String(req.body.code || '').replace(/\D/g, '');
    if (code.length !== 6) throw new HttpError(400, 'Enter the 6-digit code');
    const pass = db.get(`SELECT p.*, f.label AS flat FROM passes p JOIN flats f ON f.id = p.flat_id
                         WHERE p.code = ? AND p.valid_date = ? AND p.cancelled = 0`, code, localNow().date);
    if (!pass) throw new HttpError(404, 'Invalid code, or not valid today');
    if (pass.used_at) throw new HttpError(409, `Code already used at ${new Date(pass.used_at).toLocaleTimeString('en-IN')}`);
    const now = new Date().toISOString();
    const vehicle = str(req.body, 'vehicle', { required: false, max: 20 })?.toUpperCase() || null;
    const phone = normPhone(str(req.body, 'phone', { required: false, max: 20 })) || null;
    const id = db.tx(() => {
      db.run('UPDATE passes SET used_at = ? WHERE id = ?', now, pass.id);
      return db.run(`INSERT INTO visitors (flat_id, name, phone, purpose, vehicle, status, pass_id, logged_by, decided_by, in_at)
                     VALUES (?, ?, ?, 'guest', ?, 'inside', ?, ?, ?, ?)`,
        pass.flat_id, pass.guest_name, phone, vehicle, pass.id, req.user.id, pass.created_by, now).lastInsertRowid;
    });
    const v = getVisitor(id);
    broadcast(v);
    notify.toUsers(notify.residentsOf(pass.flat_id), 'visitor', v, {
      title: 'Your guest has arrived', body: `${pass.guest_name} entered using their gate pass.`, url: '/#/home', tag: `visitor-${v.id}`,
    });
    res.status(201).json(v);
  });

  return r;
};

function tzOffsetMinutes() {
  // Offset of the society timezone from UTC right now, in minutes (e.g. +330 for IST).
  const { TZ } = require('../util');
  const now = new Date();
  const local = new Date(now.toLocaleString('en-US', { timeZone: TZ }));
  const utc = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }));
  return Math.round((local - utc) / 60e3);
}
