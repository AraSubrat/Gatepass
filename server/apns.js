// Minimal Apple Push Notification service sender for the iOS app (token-based auth with a .p8 key).
// Apple Developer → Certificates, IDs & Profiles → Keys → create a key with "Apple Push Notifications service".
const crypto = require('node:crypto');
const fs = require('node:fs');
const http2 = require('node:http2');

function createApns() {
  const { APNS_KEY, APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID } = process.env;
  if (!APNS_KEY || !APNS_KEY_ID || !APNS_TEAM_ID || !APNS_BUNDLE_ID) return null;
  let key;
  try {
    key = APNS_KEY.includes('BEGIN PRIVATE KEY') ? APNS_KEY.replace(/\\n/g, '\n') : fs.readFileSync(APNS_KEY, 'utf8');
  } catch (e) {
    console.error('APNS_KEY could not be read:', e.message);
    return null;
  }
  const host = process.env.APNS_PRODUCTION === '1' ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com';
  let jwt = { value: null, iat: 0 };
  let session = null;

  function token() {
    const now = Math.floor(Date.now() / 1000);
    if (jwt.value && now - jwt.iat < 50 * 60) return jwt.value; // Apple wants refresh between 20 and 60 min
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${b64({ alg: 'ES256', kid: APNS_KEY_ID })}.${b64({ iss: APNS_TEAM_ID, iat: now })}`;
    const sig = crypto.sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    jwt = { value: `${unsigned}.${sig}`, iat: now };
    return jwt.value;
  }

  function client() {
    if (!session || session.closed || session.destroyed) {
      session = http2.connect(host);
      session.on('error', () => { session = null; });
      session.setTimeout(10 * 60e3, () => session?.close());
    }
    return session;
  }

  // Resolves false if the device token is no longer valid (caller should delete it).
  function send(deviceToken, { title, body, url, tag }) {
    return new Promise((resolve, reject) => {
      const req = client().request({
        ':method': 'POST',
        ':path': `/3/device/${deviceToken}`,
        authorization: `bearer ${token()}`,
        'apns-topic': APNS_BUNDLE_ID,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        ...(tag ? { 'apns-collapse-id': String(tag).slice(0, 64) } : {}),
      });
      let status = 0;
      let data = '';
      req.on('response', (h) => { status = h[':status']; });
      req.on('data', (c) => { data += c; });
      req.on('end', () => {
        if (status === 200) return resolve(true);
        const reason = (() => { try { return JSON.parse(data).reason; } catch { return ''; } })();
        if (status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered') return resolve(false);
        reject(new Error(`APNs ${status} ${reason}`));
      });
      req.on('error', reject);
      req.end(JSON.stringify({ aps: { alert: { title, body }, sound: 'default', 'thread-id': tag || 'gatepass' }, url: url || '/' }));
    });
  }

  return { send };
}

module.exports = { createApns };
