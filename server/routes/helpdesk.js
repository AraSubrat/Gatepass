const express = require('express');
const { HttpError, str } = require('../util');

const CATEGORIES = ['Plumbing', 'Electrical', 'Lift', 'Security', 'Housekeeping', 'Parking', 'Noise', 'Other'];
const STATUS_LABEL = { open: 'Open', in_progress: 'In progress', resolved: 'Resolved' };

module.exports = ({ db, notify, auth }) => {
  const r = express.Router();

  r.get('/complaints', auth('resident', 'admin'), (req, res) => {
    const all = req.user.role === 'admin' && req.query.all === '1';
    res.json(db.all(`SELECT c.*, u.name AS user_name, f.label AS flat FROM complaints c
                     JOIN users u ON u.id = c.user_id LEFT JOIN flats f ON f.id = c.flat_id
                     ${all ? '' : 'WHERE c.flat_id = ?'}
                     ORDER BY CASE c.status WHEN 'resolved' THEN 1 ELSE 0 END, c.updated_at DESC LIMIT 200`,
    ...(all ? [] : [req.user.flat_id])));
  });

  r.get('/complaints/categories', auth(), (req, res) => res.json(CATEGORIES));

  r.post('/complaints', auth('resident', 'admin'), (req, res) => {
    const category = CATEGORIES.includes(req.body.category) ? req.body.category : 'Other';
    const description = str(req.body, 'description', { max: 2000 });
    const { lastInsertRowid } = db.run('INSERT INTO complaints (flat_id, user_id, category, description) VALUES (?, ?, ?, ?)',
      req.user.flat_id, req.user.id, category, description);
    notify.toUsers(notify.admins(), 'complaint', {}, {
      title: `New ${category} issue${req.user.flat ? ` · ${req.user.flat}` : ''}`, body: description.slice(0, 120), url: '/#/admin',
    });
    res.status(201).json({ id: lastInsertRowid });
  });

  r.patch('/complaints/:id', auth('admin'), (req, res) => {
    const c = db.get('SELECT * FROM complaints WHERE id = ?', Number(req.params.id));
    if (!c) throw new HttpError(404, 'Not found');
    const status = STATUS_LABEL[req.body.status] ? req.body.status : c.status;
    const note = req.body.admin_note === undefined ? c.admin_note : str(req.body, 'admin_note', { required: false, max: 1000 });
    db.run("UPDATE complaints SET status = ?, admin_note = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?", status, note, c.id);
    if (status !== c.status) {
      notify.toUsers([c.user_id], 'complaint', {}, {
        title: `Your ${c.category} issue: ${STATUS_LABEL[status]}`, body: note || c.description.slice(0, 100), url: '/#/helpdesk',
      });
    }
    res.json({ ok: true });
  });

  return r;
};
