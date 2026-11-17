# Gatepass

A simple, ad-free app for **one** housing society: gate entry and exit, a community forum and notices, amenity booking and a helpdesk. Nothing else.

**One codebase, three ways to use it:**

| | How residents get it |
|---|---|
| 🖥️ **Web** | Open the link in any browser. On a laptop or desktop it shows a sidebar layout with two-column screens. |
| 📱 **Installed web app (PWA)** | Open the link on the phone and tap **Add to Home Screen**. No store needed. |
| 🤖 🍎 **Android & iOS apps** | Real store apps built from the same code with [Capacitor](https://capacitorjs.com) (folders `android/` and `ios/`). |

The layout adapts to the screen: bottom tabs on phones, a roomier layout on tablets, and a sidebar with two-column screens on desktops (for example, the guard console shows the entry form beside the live queue). One small server and one database file handle a society of a few hundred flats with ease.

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

## Android and iOS apps

The `android/` and `ios/` folders are native projects that bundle the same screens. The apps talk to your server over HTTPS and log in with a token, since apps can't use browser cookies. Native features used: the push notifications, the share sheet (for gate passes), the Android back button and secure app storage for the login.

### Build them

```bash
GATEPASS_SERVER_URL=https://gate.yoursociety.in npm run build:mobile   # bundle + sync both apps
npx cap open android     # opens Android Studio → Run ▶ on a phone, or Build → Generate Signed APK/Bundle
npx cap open ios         # opens Xcode (needs a Mac) → pick your team → Run ▶ or Product → Archive
```

Requirements: Android Studio (Java 21) for Android, and a Mac with Xcode 16+ for iOS.

**No Mac or Android Studio?** Every push to GitHub runs `.github/workflows/ci.yml`. It runs the tests, builds an **Android APK** you can download from the run's *Artifacts* and install on any Android phone, and checks that the iOS app compiles. Set the repository variable `GATEPASS_SERVER_URL` so the APK points at your server.

Before publishing:
1. **Change the app ID** `com.gatepass.society` in `capacitor.config.json` to your own, such as `in.greenmeadows.gate`. Then also change it in Android Studio (applicationId) and Xcode (Bundle Identifier).
2. **Icons and splash**: edit `resources/icon.svg`, then run `node scripts/make-native-assets.js`.
3. **Stores**: Google Play needs a one-time $25 developer account, and the App Store needs $99/year. If you'd rather not publish publicly, share the APK directly or use a Play Console *internal testing* track. For iPhones, *TestFlight* or Apple Business Manager *custom apps* work for a private society app.

### Push notifications in the apps

| Platform | What to set up | Server settings (`.env`) |
|---|---|---|
| Android | Create a free Firebase project → add an Android app with your app ID → download `google-services.json` into `android/app/`. Then Project settings → Service accounts → *Generate new private key*. | `FIREBASE_SERVICE_ACCOUNT` = path to that key JSON |
| iOS | Apple Developer → Keys → create a key with *Apple Push Notifications service* (.p8). In Xcode, add the *Push Notifications* capability (already declared in `App.entitlements`). | `APNS_KEY`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`; `APNS_PRODUCTION=1` for TestFlight/App Store builds |

Residents then tap **More → Turn on notifications** in the app. Visitor alerts arrive at high priority with sound.

## Tech

Node.js + Express, the SQLite built into Node, and plain HTML/CSS/JS on the front end (no framework, no trackers, no external calls). Capacitor provides the native shells. Live updates use Server-Sent Events. Notifications use Web Push for the website/PWA, Firebase for Android and APNs for iOS, with no SDKs needed on the server.

```
server/        app.js (auth: cookie for web, bearer token for apps; CORS), db.js, routes/, fcm.js + apns.js (native push)
public/        index.html, app.js (all screens, phone→desktop), styles.css, sw.js (PWA offline + push)
android/ ios/  native app projects (Capacitor)
scripts/       build-mobile.js (bundles public/ for the apps), make-native-assets.js (icons/splash)
test/          API tests (node --test)
```
