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

## Try it on your laptop (demo with sample data)

1. Install **Node.js 22 LTS** or newer from [nodejs.org](https://nodejs.org) (the default options are fine).
2. Get the code: on GitHub, switch to this branch, then **Code → Download ZIP**, and unzip it. Or use `git clone`.
3. Open a terminal in the unzipped folder (Windows: right-click the folder → *Open in Terminal*) and run:
   ```bash
   npm install
   npm run demo
   ```
4. Open **http://localhost:3000** and sign in:

   | Role | Phone | Password |
   |---|---|---|
   | Committee admin | 9000000000 | admin123 |
   | Resident (A-101) | 9811111111 | demo123 |
   | Resident (B-205) | 9822222222 | demo123 |
   | Security guard | 9333333333 | guard123 |

   To see the live gate flow, sign in as the **guard** in one window and as **Priya** in an incognito window, then log a visitor for A-101. To see the phone layout, press F12 and toggle the device toolbar (Ctrl+Shift+M).

The demo resets every time it starts and never touches real data. Press Ctrl+C to stop.

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

The `android/` and `ios/` folders are native app projects built from the same code.

### Updates reach every phone automatically ("live" mode, the default)

The apps load their screens from your server each time they open, so **any change deployed to the server reaches every resident's phone at once**, with no reinstall and no store review. All residents always share the same data, because everything lives on the one server.

- If there's no internet, the app shows a built-in "Can't connect right now" screen and reconnects by itself.
- You only need a new APK for changes to the native shell itself: a new app icon, a new native feature or a new app ID. That's rare.
- Prefer screens packed inside the app? Set `GATEPASS_APP_MODE=bundled`. Updates then need a new build.
- Note: Apple may reject live-mode apps from the *public* App Store. Use TestFlight or a private (custom) app for iPhones, or bundled mode for a public listing.

### Build them

```bash
GATEPASS_SERVER_URL=https://gate.yoursociety.in npm run build:mobile   # prepare + sync both apps
npx cap open android     # Android Studio → Build → Generate Signed APK (use the key below)
npx cap open ios         # Xcode (Mac) → pick your team → Run ▶ or Product → Archive
```

**No Mac or Android Studio needed for Android:** every push to GitHub runs `.github/workflows/ci.yml`. It runs the tests, builds a **signed Android APK** (download it from the run's *Artifacts*) and checks that the iOS app compiles. Set the repository variable `GATEPASS_SERVER_URL` first.

### Signing key (Android)

Every version of the Android app must be signed with **the same key**. Otherwise phones refuse to install updates, and residents would have to uninstall first.

1. Create the key once: `scripts/make-android-keystore.sh` (needs Java). Store the output folder in two safe places, such as the committee's Google Drive plus a USB drive. **If it's lost, you can never update the installed app.**
2. Add three GitHub secrets (repo → Settings → Secrets and variables → Actions): `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD` and `ANDROID_KEY_ALIAS`. Their values are in the generated `README-SIGNING.txt`.
3. Until the secrets are added, CI signs with a throwaway **test** key. Its artifact is named `…TEST-KEY-do-not-distribute`, so don't give that APK to residents.

### Getting the app to residents

- Copy the signed APK to the server as `data/gatepass.apk` (or set `APK_FILE`). Residents then see **📱 Get the Android app** on the sign-in page (Android phones) and under **More**. You can also share the link `https://gate.yoursociety.in/download/gatepass.apk` on the society WhatsApp group.
- iPhone residents: **Share → Add to Home Screen** works today. For a real iPhone app, use TestFlight (needs a Mac and an Apple Developer account, $99/year).
- Other options: Google Play internal/closed testing ($25 once) gives automatic installs and updates.

Before publishing, change the app ID `com.gatepass.society` in `capacitor.config.js` (plus `applicationId` in `android/app/build.gradle` and the Bundle Identifier in Xcode). To change the icon or splash screen, edit `resources/icon.svg` and run `node scripts/make-native-assets.js`.

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
scripts/       build-mobile.js (prepares the apps), make-native-assets.js (icons/splash), make-android-keystore.sh
test/          API tests (node --test)
```
