// Capacitor config for the Android/iOS apps.
//
// GATEPASS_APP_MODE (in .env or the environment):
//   live    (default) The app loads its screens from GATEPASS_SERVER_URL each time it opens, so every
//           change deployed to the server reaches all phones at once, with no reinstall. The bundled
//           www/offline.html is shown if the server can't be reached.
//   bundled           Screens are packed inside the app (works offline for the shell; updates need a new build).
const fs = require('node:fs');
const path = require('node:path');

const env = { ...process.env };
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*(GATEPASS_[A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && env[m[1]] === undefined) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
const serverUrl = (env.GATEPASS_SERVER_URL || '').replace(/\/$/, '');
const live = (env.GATEPASS_APP_MODE || 'live') !== 'bundled' && Boolean(serverUrl);

/** @type {import('@capacitor/cli').CapacitorConfig} */
module.exports = {
  appId: 'com.gatepass.society',
  appName: 'Gatepass',
  webDir: 'www',
  backgroundColor: '#0f5b52',
  server: live
    ? { url: serverUrl, errorPath: 'offline.html', cleartext: serverUrl.startsWith('http://') }
    : undefined,
  android: { allowMixedContent: false },
  ios: { contentInset: 'never' },
  plugins: {
    PushNotifications: { presentationOptions: ['badge', 'sound', 'alert'] },
    SystemBars: { insetsHandling: 'css' },
  },
};
