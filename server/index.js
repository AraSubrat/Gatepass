// Entry point. Configure with environment variables (see README / .env.example).
const fs = require('node:fs');
const path = require('node:path');

// Minimal .env loader so no extra dependency is needed.
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

const { createApp } = require('./app');
const { app, ensureAdmin } = createApp();

if (process.env.ADMIN_PHONE && process.env.ADMIN_PASSWORD) {
  if (ensureAdmin(process.env.ADMIN_PHONE, process.env.ADMIN_PASSWORD, process.env.ADMIN_NAME || 'Committee Admin')) {
    console.log(`Created first admin account for ${process.env.ADMIN_PHONE}`);
  }
}

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`Gatepass running on http://localhost:${port}`));
