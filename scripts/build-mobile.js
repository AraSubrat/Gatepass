// Prepares the bundled web assets for the Android/iOS apps:
//   GATEPASS_SERVER_URL=https://gate.yoursociety.in npm run build:mobile
// Copies public/ to www/ and bakes the server address into www/config.js, then runs `cap sync`.
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*(GATEPASS_SERVER_URL)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

const server = (process.env.GATEPASS_SERVER_URL || '').replace(/\/$/, '');
if (!/^https?:\/\/[^/]+$/.test(server)) {
  console.error('Set GATEPASS_SERVER_URL to your server address, e.g. GATEPASS_SERVER_URL=https://gate.yoursociety.in');
  process.exit(1);
}
if (server.startsWith('http://')) {
  console.warn('⚠  http:// only works for local testing. Phones need https:// for a real release.');
}

const www = path.join(root, 'www');
fs.rmSync(www, { recursive: true, force: true });
fs.cpSync(path.join(root, 'public'), www, { recursive: true });
fs.rmSync(path.join(www, 'sw.js')); // the native shell doesn't use a service worker
fs.writeFileSync(path.join(www, 'config.js'), `window.GATEPASS_SERVER = ${JSON.stringify(server)};\n`);
console.log(`Bundled app → ${server}`);

if (!process.argv.includes('--no-sync')) execSync('npx cap sync', { cwd: root, stdio: 'inherit' });
