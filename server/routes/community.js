const express = require('express');
const { HttpError, str } = require('../util');

module.exports = ({ db, notify, auth }) => {
  const r = express.Router();

  r.get('/posts', auth(), (req, res) => {
    const kind = req.query.kind === 'notice' || req.query.kind === 'discussion' ? req.query.kind : null;
    res.json(db.all(`
      SELECT p.id, p.kind, p.title, substr(p.body, 1, 280) AS excerpt, p.pinned, p.created_at, p.user_id,
             u.name AS author, f.label AS flat, u.role AS author_role,
             (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comments
      FROM posts p JOIN users u ON u.id = p.user_id LEFT JOIN flats f ON f.id = u.flat_id
      ${kind ? 'WHERE p.kind = ?' : ''}
      ORDER BY p.pinned DESC, p.created_at DESC LIMIT 100`, ...(kind ? [kind] : [])));
  });

  r.get('/posts/:id', auth(), (req, res) => {
    const post = db.get(`SELECT p.*, u.name AS author, f.label AS flat, u.role AS author_role
                         FROM posts p JOIN users u ON u.id = p.user_id LEFT JOIN flats f ON f.id = u.flat_id
                         WHERE p.id = ?`, Number(req.params.id));
    if (!post) throw new HttpError(404, 'Post not found');
    post.comments = db.all(`SELECT c.id, c.body, c.created_at, c.user_id, u.name AS author, f.label AS flat
                            FROM comments c JOIN users u ON u.id = c.user_id LEFT JOIN flats f ON f.id = u.flat_id
                            WHERE c.post_id = ? ORDER BY c.created_at`, post.id);
    res.json(post);
  });

  r.post('/posts', auth('resident', 'admin'), (req, res) => {
    const kind = req.body.kind === 'notice' ? 'notice' : 'discussion';
    if (kind === 'notice' && req.user.role !== 'admin') throw new HttpError(403, 'Only the committee can post notices');
    const title = str(req.body, 'title', { max: 150 });
    const body = str(req.body, 'body', { max: 5000 });
    const pinned = req.user.role === 'admin' && req.body.pinned ? 1 : 0;
    const { lastInsertRowid } = db.run('INSERT INTO posts (user_id, kind, title, body, pinned) VALUES (?, ?, ?, ?, ?)',
      req.user.id, kind, title, body, pinned);
    if (kind === 'notice') {
      const everyone = db.all("SELECT id FROM users WHERE status = 'active' AND role != 'guard' AND id != ?", req.user.id).map((u) => u.id);
      notify.toUsers(everyone, 'post', { id: lastInsertRowid }, { title: `Notice: ${title}`, body: body.slice(0, 120), url: `/#/post/${lastInsertRowid}` });
    }
    res.status(201).json({ id: lastInsertRowid });
  });

  r.patch('/posts/:id', auth('admin'), (req, res) => {
    db.run('UPDATE posts SET pinned = ? WHERE id = ?', req.body.pinned ? 1 : 0, Number(req.params.id));
    res.json({ ok: true });
  });

  r.delete('/posts/:id', auth('resident', 'admin'), (req, res) => {
    const post = db.get('SELECT user_id FROM posts WHERE id = ?', Number(req.params.id));
    if (!post) throw new HttpError(404, 'Post not found');
    if (post.user_id !== req.user.id && req.user.role !== 'admin') throw new HttpError(403, 'Not allowed');
    db.run('DELETE FROM posts WHERE id = ?', Number(req.params.id));
    res.json({ ok: true });
  });

  r.post('/posts/:id/comments', auth('resident', 'admin'), (req, res) => {
    const post = db.get('SELECT id, user_id, title FROM posts WHERE id = ?', Number(req.params.id));
    if (!post) throw new HttpError(404, 'Post not found');
    const body = str(req.body, 'body', { max: 2000 });
    const { lastInsertRowid } = db.run('INSERT INTO comments (post_id, user_id, body) VALUES (?, ?, ?)', post.id, req.user.id, body);
    if (post.user_id !== req.user.id) {
      notify.toUsers([post.user_id], 'comment', { post_id: post.id },
        { title: `${req.user.name} replied`, body: `On "${post.title}": ${body.slice(0, 100)}`, url: `/#/post/${post.id}` });
    }
    res.status(201).json({ id: lastInsertRowid });
  });

  r.delete('/comments/:id', auth('resident', 'admin'), (req, res) => {
    const c = db.get('SELECT user_id FROM comments WHERE id = ?', Number(req.params.id));
    if (!c) throw new HttpError(404, 'Comment not found');
    if (c.user_id !== req.user.id && req.user.role !== 'admin') throw new HttpError(403, 'Not allowed');
    db.run('DELETE FROM comments WHERE id = ?', Number(req.params.id));
    res.json({ ok: true });
  });

  return r;
};
