// Prepares the Android/iOS apps:
//   GATEPASS_SERVER_URL=https://gate.yoursociety.in npm run build:mobile
// Copies public/ to www/, bakes the server address into www/config.js, writes the offline page,
// then runs `cap sync`. See capacitor.config.js for live (default) vs bundled mode.
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*(GATEPASS_[A-Z_]+)\s*=\s*(.*?)\s*$/);
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
// Shown by the app when it can't reach the server (no internet, server down). Retries automatically.
fs.writeFileSync(path.join(www, 'offline.html'), `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Gatepass</title>
<style>
  html,body{margin:0;height:100%;font-family:system-ui,-apple-system,Roboto,sans-serif;background:#0f5b52;color:#fff}
  main{min-height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:24px;box-sizing:border-box}
  img{width:72px;height:72px;margin-bottom:16px}
  h1{font-size:1.3rem;margin:0 0 8px} p{opacity:.85;margin:0 0 24px;max-width:320px;line-height:1.45}
  button{font:inherit;font-weight:600;border:0;border-radius:12px;padding:14px 28px;background:#fff;color:#0f5b52}
</style></head>
<body><main>
  <img src="icons/icon.svg" alt="">
  <h1>Can't connect right now</h1>
  <p>Check your internet connection. We'll keep trying, or tap below.</p>
  <button id="retry">Try again</button>
</main>
<script>
  var SERVER = ${JSON.stringify(server)};
  function retry(){ location.href = SERVER + '/'; }
  document.getElementById('retry').onclick = retry;
  window.addEventListener('online', retry);
  setInterval(function(){ if (navigator.onLine) fetch(SERVER + '/api/config', {cache:'no-store'}).then(function(r){ if (r.ok) retry(); }).catch(function(){}); }, 10000);
</script>
</body></html>
`);
const mode = (process.env.GATEPASS_APP_MODE || 'live') === 'bundled' ? 'bundled' : 'live';
console.log(mode === 'live'
  ? `Live app → loads screens from ${server} (updates reach phones instantly)`
  : `Bundled app → screens packed in the app, API at ${server}`);

if (!process.argv.includes('--no-sync')) execSync('npx cap sync', { cwd: root, stdio: 'inherit' });
