const express = require('express');
const { HttpError, str, localNow, addDays, slotsFor, isDate, isTime, toMin } = require('../util');

module.exports = ({ db, auth }) => {
  const r = express.Router();

  r.get('/amenities', auth(), (req, res) => {
    const all = req.user.role === 'admin' && req.query.all === '1';
    res.json(db.all(`SELECT * FROM amenities ${all ? '' : 'WHERE active = 1'} ORDER BY name`));
  });

  // Slots for one amenity on one date, with who booked them.
  r.get('/amenities/:id/slots', auth(), (req, res) => {
    const a = db.get('SELECT * FROM amenities WHERE id = ?', Number(req.params.id));
    if (!a) throw new HttpError(404, 'Amenity not found');
    const now = localNow();
    const date = isDate(req.query.date) ? req.query.date : now.date;
    const taken = new Map(db.all(`SELECT b.id, b.start_time, b.flat_id, f.label AS flat FROM bookings b JOIN flats f ON f.id = b.flat_id
                                  WHERE b.amenity_id = ? AND b.date = ? AND b.status = 'booked'`, a.id, date).map((b) => [b.start_time, b]));
    res.json({
      amenity: a,
      date,
      slots: slotsFor(a).map((s) => {
        const b = taken.get(s.start);
        return {
          ...s,
          past: date < now.date || (date === now.date && s.start <= now.time),
          booked: Boolean(b),
          mine: b ? b.flat_id === req.user.flat_id : false,
          booking_id: b && (b.flat_id === req.user.flat_id || req.user.role === 'admin') ? b.id : null,
          flat: b ? b.flat : null,
        };
      }),
    });
  });

  r.post('/bookings', auth('resident', 'admin'), (req, res) => {
    if (!req.user.flat_id) throw new HttpError(400, 'Your account is not linked to a flat');
    const a = db.get('SELECT * FROM amenities WHERE id = ? AND active = 1', Number(req.body.amenity_id));
    if (!a) throw new HttpError(404, 'Amenity not available');
    const { date, start_time: start } = req.body;
    if (!isDate(date) || !isTime(start)) throw new HttpError(400, 'Pick a date and slot');
    const now = localNow();
    if (date < now.date || (date === now.date && start <= now.time)) throw new HttpError(400, 'That slot has already started');
    if (date > addDays(now.date, a.max_days_ahead)) throw new HttpError(400, `You can book up to ${a.max_days_ahead} days ahead`);
    if (!slotsFor(a).some((s) => s.start === start)) throw new HttpError(400, 'Invalid slot');
    // Fair use: one slot per flat per amenity per day.
    if (db.get("SELECT id FROM bookings WHERE amenity_id = ? AND flat_id = ? AND date = ? AND status = 'booked'", a.id, req.user.flat_id, date)) {
      throw new HttpError(409, `Your flat already has a ${a.name} booking that day`);
    }
    try {
      const { lastInsertRowid } = db.run('INSERT INTO bookings (amenity_id, flat_id, user_id, date, start_time) VALUES (?, ?, ?, ?, ?)',
        a.id, req.user.flat_id, req.user.id, date, start);
      res.status(201).json({ id: lastInsertRowid });
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'Sorry, someone just booked that slot');
      throw e;
    }
  });

  r.get('/bookings', auth(), (req, res) => {
    const today = localNow().date;
    if (req.user.role === 'admin' && req.query.all === '1') {
      return res.json(db.all(`SELECT b.*, a.name AS amenity, a.slot_minutes, f.label AS flat, u.name AS user_name
                              FROM bookings b JOIN amenities a ON a.id = b.amenity_id JOIN flats f ON f.id = b.flat_id JOIN users u ON u.id = b.user_id
                              WHERE b.status = 'booked' AND b.date >= ? ORDER BY b.date, b.start_time`, today));
    }
    res.json(db.all(`SELECT b.*, a.name AS amenity, a.slot_minutes, u.name AS user_name
                     FROM bookings b JOIN amenities a ON a.id = b.amenity_id JOIN users u ON u.id = b.user_id
                     WHERE b.flat_id = ? AND b.status = 'booked' AND b.date >= ? ORDER BY b.date, b.start_time`, req.user.flat_id, today));
  });

  r.delete('/bookings/:id', auth('resident', 'admin'), (req, res) => {
    const b = db.get("SELECT * FROM bookings WHERE id = ? AND status = 'booked'", Number(req.params.id));
    if (!b || (b.flat_id !== req.user.flat_id && req.user.role !== 'admin')) throw new HttpError(404, 'Booking not found');
    db.run("UPDATE bookings SET status = 'cancelled' WHERE id = ?", b.id);
    res.json({ ok: true });
  });

  // ---- Admin: manage amenities ----
  function amenityFields(body) {
    const f = {
      name: str(body, 'name', { max: 60 }),
      description: str(body, 'description', { required: false, max: 500 }) || '',
      open_time: body.open_time, close_time: body.close_time,
      slot_minutes: Number(body.slot_minutes), max_days_ahead: Number(body.max_days_ahead ?? 7),
      active: body.active === false ? 0 : 1,
    };
    if (!isTime(f.open_time) || !isTime(f.close_time) || toMin(f.open_time) >= toMin(f.close_time)) throw new HttpError(400, 'Check opening and closing time');
    if (!(f.slot_minutes >= 15 && f.slot_minutes <= 720)) throw new HttpError(400, 'Slot length must be 15 to 720 minutes');
    if (!(f.max_days_ahead >= 0 && f.max_days_ahead <= 90)) throw new HttpError(400, 'Advance booking must be 0 to 90 days');
    return f;
  }

  r.post('/amenities', auth('admin'), (req, res) => {
    const f = amenityFields(req.body);
    const { lastInsertRowid } = db.run(
      'INSERT INTO amenities (name, description, open_time, close_time, slot_minutes, max_days_ahead, active) VALUES (?, ?, ?, ?, ?, ?, ?)',
      f.name, f.description, f.open_time, f.close_time, f.slot_minutes, f.max_days_ahead, f.active);
    res.status(201).json({ id: lastInsertRowid });
  });

  r.put('/amenities/:id', auth('admin'), (req, res) => {
    const f = amenityFields(req.body);
    const out = db.run(
      'UPDATE amenities SET name = ?, description = ?, open_time = ?, close_time = ?, slot_minutes = ?, max_days_ahead = ?, active = ? WHERE id = ?',
      f.name, f.description, f.open_time, f.close_time, f.slot_minutes, f.max_days_ahead, f.active, Number(req.params.id));
    if (!out.changes) throw new HttpError(404, 'Amenity not found');
    res.json({ ok: true });
  });

  return r;
};
