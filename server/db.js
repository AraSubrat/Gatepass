// SQLite storage using Node's built-in driver (no native modules to compile).
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS flats (
  id INTEGER PRIMARY KEY,
  label TEXT NOT NULL UNIQUE COLLATE NOCASE   -- e.g. "A-101"
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('resident','guard','admin')),
  flat_id INTEGER REFERENCES flats(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','disabled')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

-- Every person who comes to the gate.
CREATE TABLE IF NOT EXISTS visitors (
  id INTEGER PRIMARY KEY,
  flat_id INTEGER NOT NULL REFERENCES flats(id),
  name TEXT NOT NULL,
  phone TEXT,
  purpose TEXT NOT NULL DEFAULT 'guest',      -- guest | delivery | cab | service | other
  vehicle TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','denied','inside','left_at_gate','exited')),
  pass_id INTEGER REFERENCES passes(id),
  logged_by INTEGER REFERENCES users(id),     -- guard
  decided_by INTEGER REFERENCES users(id),    -- resident who approved/denied
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  in_at TEXT,
  out_at TEXT
);
CREATE INDEX IF NOT EXISTS visitors_flat ON visitors(flat_id, created_at);
CREATE INDEX IF NOT EXISTS visitors_status ON visitors(status);

-- Pre-approved guest passes (resident shares a 6-digit code).
CREATE TABLE IF NOT EXISTS passes (
  id INTEGER PRIMARY KEY,
  flat_id INTEGER NOT NULL REFERENCES flats(id),
  created_by INTEGER NOT NULL REFERENCES users(id),
  guest_name TEXT NOT NULL,
  code TEXT NOT NULL,
  valid_date TEXT NOT NULL,                   -- YYYY-MM-DD (society local date)
  used_at TEXT,
  cancelled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS passes_code ON passes(code, valid_date);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('notice','discussion')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS amenities (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  open_time TEXT NOT NULL DEFAULT '06:00',
  close_time TEXT NOT NULL DEFAULT '22:00',
  slot_minutes INTEGER NOT NULL DEFAULT 60,
  max_days_ahead INTEGER NOT NULL DEFAULT 7,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY,
  amenity_id INTEGER NOT NULL REFERENCES amenities(id),
  flat_id INTEGER NOT NULL REFERENCES flats(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  date TEXT NOT NULL,                         -- YYYY-MM-DD
  start_time TEXT NOT NULL,                   -- HH:MM
  status TEXT NOT NULL DEFAULT 'booked' CHECK (status IN ('booked','cancelled')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- One active booking per amenity slot.
CREATE UNIQUE INDEX IF NOT EXISTS bookings_slot
  ON bookings(amenity_id, date, start_time) WHERE status = 'booked';

CREATE TABLE IF NOT EXISTS complaints (
  id INTEGER PRIMARY KEY,
  flat_id INTEGER REFERENCES flats(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved')),
  admin_note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS native_push_tokens (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  keys TEXT NOT NULL
);
`;

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);

  // Small helpers so route code stays readable.
  db.get = (sql, ...p) => db.prepare(sql).get(...p);
  db.all = (sql, ...p) => db.prepare(sql).all(...p);
  db.run = (sql, ...p) => db.prepare(sql).run(...p);
  db.tx = (fn) => {
    db.exec('BEGIN');
    try { const r = fn(); db.exec('COMMIT'); return r; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  };
  return db;
}

module.exports = { open };
