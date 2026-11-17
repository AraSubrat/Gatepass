const crypto = require('node:crypto');

const TZ = process.env.TZ_SOCIETY || 'Asia/Kolkata';

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(pw, stored) {
  const [, saltHex, hashHex] = String(stored).split('$');
  if (!saltHex || !hashHex) return false;
  const hash = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 32);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}

// Society-local date as YYYY-MM-DD and time as HH:MM.
function localNow(d = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(d).map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const fromMin = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

function slotsFor(amenity) {
  const out = [];
  for (let m = toMin(amenity.open_time); m + amenity.slot_minutes <= toMin(amenity.close_time); m += amenity.slot_minutes) {
    out.push({ start: fromMin(m), end: fromMin(m + amenity.slot_minutes) });
  }
  return out;
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Validates and trims a string field from a request body.
function str(body, key, { required = true, max = 500 } = {}) {
  const v = body?.[key];
  if (v === undefined || v === null || String(v).trim() === '') {
    if (required) throw new HttpError(400, `${key} is required`);
    return null;
  }
  const s = String(v).trim();
  if (s.length > max) throw new HttpError(400, `${key} is too long (max ${max})`);
  return s;
}

const normPhone = (p) => String(p || '').replace(/[^\d+]/g, '').replace(/^(\+?91)?(?=\d{10}$)/, '');

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const isTime = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s || '');

module.exports = {
  TZ, hashPassword, verifyPassword, localNow, addDays, slotsFor, toMin,
  HttpError, str, normPhone, isDate, isTime,
};
