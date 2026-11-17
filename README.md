# Gatepass

A simple, ad-free app for **one** housing society: gate entry and exit, a community forum and notices, amenity booking and a helpdesk. Nothing else.

It's a web app that installs to the home screen (a PWA), so there's no app store. Residents open the link and tap **Add to Home Screen**. One small server and one database file handle a society of a few hundred flats with ease.

## What it does

| Who | Can do |
|---|---|
| **Security guard** | Log a visitor (flat, name, purpose, vehicle) and send it for approval · verify a guest's 6-digit gate pass · see who is waiting, who is inside and which parcels are at the gate · mark exit · one-tap call to the flat · searchable visitor log |
| **Resident** | Approve / deny / "leave at gate" a visitor live (with a phone notification) · create gate passes for guests and share them on WhatsApp · visitor history · book amenities · forum discussions · raise helpdesk issues |
| **Committee (admin)** | Approve sign-ups · add flats in bulk (`A-101..A-120`) · add guards and residents · reset passwords · set up amenities (hours, slot length, how far ahead) · post pinned notices (sent to everyone) · manage helpdesk issues · see all bookings and the full visitor log |

Rules built in: one amenity slot per flat per day, no double booking, gate passes work once and only on their date, and residents only ever see their own flat's visitors.

## Run it locally

Needs Node.js 22.13 or newer.

```bash
npm install
cp .env.example .env      # edit the society name and admin phone/password
npm start                 # http://localhost:3000
npm test                  # API tests
```

Sign in with the admin phone and password from `.env`, then:
1. **More → Committee admin → Flats**: add every flat, e.g. `A-101..A-112` per line.
2. **People**: add your guards. Each gets a temporary password.
3. **Amenities**: add the clubhouse, courts and so on.
4. Share the link with residents. They register, and you approve them on the Overview tab.

## Put it online

Any small VPS (₹400–800/month), a Raspberry Pi or a free-tier host that keeps a persistent disk will do. **HTTPS is required** for install-to-home-screen and notifications.

```bash
docker build -t gatepass .
docker run -d --name gatepass -p 3000:3000 -v gatepass-data:/data --env-file .env --restart unless-stopped gatepass
```

Put it behind Caddy for automatic HTTPS (`gate.yoursociety.in { reverse_proxy localhost:3000 }`).

**Phone notifications**: run `npm run vapid` once, put the two keys in `.env` and restart. Residents then tap **More → Turn on notifications**. On iPhone (iOS 16.4+), the app must be added to the Home Screen first.

**Backups**: everything is in a single file (`data/gatepass.db`). Copy it daily, e.g. `sqlite3 data/gatepass.db ".backup backup-$(date +%F).db"`.

## Tech

Node.js + Express, the SQLite built into Node, and plain HTML/CSS/JS on the front end (no framework, no trackers, no external calls). Live updates use Server-Sent Events, and notifications use Web Push.

```
server/        app.js (auth, sessions), db.js (schema), routes/ (gate, community, amenities, helpdesk, admin)
public/        index.html, app.js (all screens), styles.css, sw.js (offline + push)
test/          API tests (node --test)
```
