const express = require('express');
const crypto = require('node:crypto');
const { HttpError, str, normPhone, hashPassword, localNow } = require('../util');

module.exports = ({ db, notify, auth }) => {
  const r = express.Router();
  const admin = auth('admin');

  r.get('/admin/summary', admin, (req, res) => {
    const today = localNow().date;
    res.json({
      flats: db.get('SELECT COUNT(*) n FROM flats').n,
      residents: db.get("SELECT COUNT(*) n FROM users WHERE role != 'guard' AND status = 'active'").n,
      flats_on_app: db.get("SELECT COUNT(DISTINCT flat_id) n FROM users WHERE status = 'active' AND flat_id IS NOT NULL").n,
      pending_users: db.get("SELECT COUNT(*) n FROM users WHERE status = 'pending'").n,
      open_complaints: db.get("SELECT COUNT(*) n FROM complaints WHERE status != 'resolved'").n,
      visitors_inside: db.get("SELECT COUNT(*) n FROM visitors WHERE status = 'inside'").n,
      bookings_today: db.get("SELECT COUNT(*) n FROM bookings WHERE status = 'booked' AND date = ?", today).n,
    });
  });

  // ---- Users ----
  r.get('/admin/users', admin, (req, res) => {
    const status = ['pending', 'active', 'disabled'].includes(req.query.status) ? req.query.status : null;
    res.json(db.all(`SELECT u.id, u.name, u.phone, u.role, u.status, u.flat_id, f.label AS flat, u.created_at
                     FROM users u LEFT JOIN flats f ON f.id = u.flat_id
                     ${status ? 'WHERE u.status = ?' : ''} ORDER BY u.status = 'pending' DESC, f.label, u.name`,
    ...(status ? [status] : [])));
  });

  r.post('/admin/users', admin, (req, res) => {
    const name = str(req.body, 'name', { max: 80 });
    const phone = normPhone(str(req.body, 'phone', { max: 20 }));
    const role = ['resident', 'guard', 'admin'].includes(req.body.role) ? req.body.role : 'resident';
    const flatId = req.body.flat_id ? Number(req.body.flat_id) : null;
    if (role === 'resident' && !flatId) throw new HttpError(400, 'Residents need a flat');
    if (flatId && !db.get('SELECT id FROM flats WHERE id = ?', flatId)) throw new HttpError(400, 'Unknown flat');
    if (db.get('SELECT id FROM users WHERE phone = ?', phone)) throw new HttpError(409, 'Phone number already registered');
    const password = str(req.body, 'password', { required: false, max: 200 }) || tempPassword();
    db.run("INSERT INTO users (name, phone, password_hash, role, flat_id, status) VALUES (?, ?, ?, ?, ?, 'active')",
      name, phone, hashPassword(password), role, role === 'guard' ? null : flatId);
    res.status(201).json({ ok: true, password });
  });

  r.patch('/admin/users/:id', admin, (req, res) => {
    const id = Number(req.params.id);
    const u = db.get('SELECT * FROM users WHERE id = ?', id);
    if (!u) throw new HttpError(404, 'User not found');
    const status = ['active', 'disabled'].includes(req.body.status) ? req.body.status : u.status;
    const role = ['resident', 'guard', 'admin'].includes(req.body.role) ? req.body.role : u.role;
    const flatId = req.body.flat_id !== undefined ? (req.body.flat_id ? Number(req.body.flat_id) : null) : u.flat_id;
    if (id === req.user.id && (status !== 'active' || role !== 'admin')) throw new HttpError(400, "You can't remove your own admin access");
    db.run('UPDATE users SET status = ?, role = ?, flat_id = ? WHERE id = ?', status, role, role === 'guard' ? null : flatId, id);
    if (status !== 'active') db.run('DELETE FROM sessions WHERE user_id = ?', id);
    if (u.status === 'pending' && status === 'active') {
      notify.toUsers([id], 'account', {}, { title: 'Welcome!', body: 'Your account has been approved.', url: '/' });
    }
    res.json({ ok: true });
  });

  r.delete('/admin/users/:id', admin, (req, res) => {
    // Only pending sign-ups can be deleted outright; active users are disabled to keep history intact.
    const out = db.run("DELETE FROM users WHERE id = ? AND status = 'pending'", Number(req.params.id));
    if (!out.changes) throw new HttpError(400, 'Only pending sign-ups can be rejected. Disable active users instead.');
    res.json({ ok: true });
  });

  r.post('/admin/users/:id/reset-password', admin, (req, res) => {
    const password = tempPassword();
    const out = db.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(password), Number(req.params.id));
    if (!out.changes) throw new HttpError(404, 'User not found');
    db.run('DELETE FROM sessions WHERE user_id = ?', Number(req.params.id));
    res.json({ password });
  });

  // ---- Flats ----
  r.get('/admin/flats', admin, (req, res) => {
    res.json(db.all(`SELECT f.id, f.label,
                       (SELECT COUNT(*) FROM users u WHERE u.flat_id = f.id AND u.status = 'active') AS members
                     FROM flats f ORDER BY f.label`));
  });

  // Accepts a list of labels separated by newlines/commas, or ranges like "A-101..A-110".
  r.post('/admin/flats', admin, (req, res) => {
    const text = str(req.body, 'labels', { max: 20000 });
    const labels = [];
    for (const raw of text.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean)) {
      const m = raw.match(/^(.*?)(\d+)\s*\.\.\s*\1?(\d+)$/);
      if (m) {
        const [, prefix, a, b] = m;
        if (Number(b) - Number(a) > 500 || Number(b) < Number(a)) throw new HttpError(400, `Bad range: ${raw}`);
        for (let n = Number(a); n <= Number(b); n++) labels.push(`${prefix}${String(n).padStart(a.length, '0')}`);
      } else {
        labels.push(raw);
      }
    }
    if (labels.some((l) => l.length > 20)) throw new HttpError(400, 'Flat labels must be 20 characters or less');
    let added = 0;
    db.tx(() => { for (const l of labels) added += db.run('INSERT OR IGNORE INTO flats (label) VALUES (?)', l).changes; });
    res.status(201).json({ added, skipped: labels.length - added });
  });

  r.delete('/admin/flats/:id', admin, (req, res) => {
    const id = Number(req.params.id);
    const used = db.get(`SELECT (SELECT COUNT(*) FROM users WHERE flat_id = ?) + (SELECT COUNT(*) FROM visitors WHERE flat_id = ?)
                         + (SELECT COUNT(*) FROM bookings WHERE flat_id = ?) AS n`, id, id, id).n;
    if (used) throw new HttpError(409, 'This flat has residents or history and cannot be deleted');
    db.run('DELETE FROM flats WHERE id = ?', id);
    res.json({ ok: true });
  });

  return r;
};

function tempPassword() {
  // Easy to read out over the phone: 8 chars without look-alikes.
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from({ length: 8 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
}
