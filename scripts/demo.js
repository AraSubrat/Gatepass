// Starts Gatepass with a fresh demo society full of sample data, so you can try every screen.
//   npm run demo          → http://localhost:3000
// Demo data lives in data/demo.db and is reset on every start (your real data/gatepass.db is untouched).
const fs = require('node:fs');
const path = require('node:path');

const dbFile = path.join(__dirname, '..', 'data', 'demo.db');
for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) fs.rmSync(f, { force: true });

process.env.SOCIETY_NAME = process.env.SOCIETY_NAME || 'Green Meadows (Demo)';
const { createApp } = require('../server/app');
const { hashPassword, localNow, addDays } = require('../server/util');
const { app, db } = createApp({ dbFile });

const ACCOUNTS = [
  // name, phone, password, role, flat, status
  ['Committee Admin', '9000000000', 'admin123', 'admin', 'A-102', 'active'],
  ['Priya Sharma', '9811111111', 'demo123', 'resident', 'A-101', 'active'],
  ['Rahul Mehta', '9822222222', 'demo123', 'resident', 'B-205', 'active'],
  ['Ramesh (Security)', '9333333333', 'guard123', 'guard', null, 'active'],
  ['Neha Gupta', '9844444444', 'demo123', 'resident', 'A-108', 'pending'],
];

db.tx(() => {
  for (const t of ['A', 'B', 'C']) for (let f = 1; f <= 4; f++) for (let n = 1; n <= 5; n++) {
    db.run('INSERT INTO flats (label) VALUES (?)', `${t}-${f}0${n}`);
  }
  const flat = (label) => db.get('SELECT id FROM flats WHERE label = ?', label)?.id ?? null;
  const ids = {};
  for (const [name, phone, pw, role, f, status] of ACCOUNTS) {
    ids[phone] = db.run('INSERT INTO users (name, phone, password_hash, role, flat_id, status) VALUES (?, ?, ?, ?, ?, ?)',
      name, phone, hashPassword(pw), role, flat(f), status).lastInsertRowid;
  }
  const admin = ids['9000000000'], priya = ids['9811111111'], rahul = ids['9822222222'], guard = ids['9333333333'];

  const clubhouse = db.run(`INSERT INTO amenities (name, description, open_time, close_time, slot_minutes, max_days_ahead)
    VALUES ('Clubhouse', 'Party hall with kitchen. Max 60 guests, music till 10 pm.', '09:00', '22:00', 180, 14)`).lastInsertRowid;
  db.run(`INSERT INTO amenities (name, description, open_time, close_time, slot_minutes, max_days_ahead)
    VALUES ('Badminton court', 'Non-marking shoes only.', '06:00', '22:00', 60, 3)`);
  db.run(`INSERT INTO amenities (name, description, open_time, close_time, slot_minutes, max_days_ahead)
    VALUES ('Guest room', 'Overnight stay for visiting family.', '12:00', '23:00', 660, 30)`);
  db.run("INSERT INTO bookings (amenity_id, flat_id, user_id, date, start_time) VALUES (?, ?, ?, ?, '18:00')",
    clubhouse, flat('B-205'), rahul, addDays(localNow().date, 2));

  db.run(`INSERT INTO posts (user_id, kind, title, body, pinned) VALUES (?, 'notice', 'Water supply off on Sunday, 10 am – 1 pm',
    'The overhead tanks will be cleaned on Sunday. Please store water in advance. Sorry for the inconvenience.', 1)`, admin);
  db.run(`INSERT INTO posts (user_id, kind, title, body) VALUES (?, 'notice', 'Maintenance due by the 10th',
    'Monthly maintenance for this month is due by the 10th. Please pay to the society account and share the reference with the treasurer.')`, admin);
  const post = db.run(`INSERT INTO posts (user_id, kind, title, body) VALUES (?, 'discussion', 'Sunday morning badminton group?',
    'Anyone up for badminton at 7 am on Sundays? Beginners welcome!')`, priya).lastInsertRowid;
  db.run("INSERT INTO comments (post_id, user_id, body) VALUES (?, ?, 'Count me in! I can bring extra shuttles.')", post, rahul);

  const ago = (min) => new Date(Date.now() - min * 60e3).toISOString();
  db.run(`INSERT INTO visitors (flat_id, name, phone, purpose, vehicle, status, logged_by, decided_by, created_at, in_at, out_at)
    VALUES (?, 'Amazon – Suresh', '9876500001', 'delivery', NULL, 'exited', ?, ?, ?, ?, ?)`, flat('A-101'), guard, priya, ago(180), ago(178), ago(170));
  db.run(`INSERT INTO visitors (flat_id, name, phone, purpose, vehicle, status, logged_by, decided_by, created_at, in_at)
    VALUES (?, 'Urban Company – Plumber', '9876500002', 'service', 'KA03HY4410', 'inside', ?, ?, ?, ?)`, flat('B-205'), guard, rahul, ago(40), ago(39));
  db.run(`INSERT INTO visitors (flat_id, name, phone, purpose, vehicle, status, logged_by, created_at)
    VALUES (?, 'Swiggy – Ravi', '9876500003', 'delivery', 'KA05MN4321', 'pending', ?, ?)`, flat('A-101'), guard, ago(1));

  db.run("INSERT INTO complaints (flat_id, user_id, category, description) VALUES (?, ?, 'Electrical', 'Corridor light on the 1st floor of A block is not working.')", flat('A-101'), priya);
  db.run(`INSERT INTO complaints (flat_id, user_id, category, description, status, admin_note)
    VALUES (?, ?, 'Lift', 'B block lift makes a grinding noise.', 'in_progress', 'Technician visiting tomorrow morning.')`, flat('B-205'), rahul);
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`\n  Gatepass demo running → http://localhost:${port}\n`);
  console.log('  Sign in with any of these (open a second browser / incognito window to be two people at once):');
  for (const [name, phone, pw, role, flat, status] of ACCOUNTS.filter((a) => a[5] === 'active')) {
    console.log(`    ${role.padEnd(9)} ${phone}  /  ${pw.padEnd(9)} ${name}${flat ? ` (${flat})` : ''}`);
  }
  console.log('\n  Demo data resets every time you restart. Press Ctrl+C to stop.\n');
});
