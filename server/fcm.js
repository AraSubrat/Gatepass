// Minimal Firebase Cloud Messaging (HTTP v1) sender for the native Android/iOS apps.
// Uses a service-account JSON (Firebase console → Project settings → Service accounts → Generate key).
// No SDK dependency: signs the OAuth JWT with node:crypto.
const crypto = require('node:crypto');
const fs = require('node:fs');

function loadServiceAccount() {
  const v = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!v) return null;
  try {
    return JSON.parse(v.trim().startsWith('{') ? v : fs.readFileSync(v, 'utf8'));
  } catch (e) {
    console.error('FIREBASE_SERVICE_ACCOUNT could not be read:', e.message);
    return null;
  }
}

function createFcm() {
  const sa = loadServiceAccount();
  if (!sa) return null;
  let cached = { token: null, exp: 0 };

  async function accessToken() {
    if (cached.token && Date.now() < cached.exp - 60e3) return cached.token;
    const now = Math.floor(Date.now() / 1000);
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
      iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
    })}`;
    const sig = crypto.sign('RSA-SHA256', Buffer.from(unsigned), sa.private_key).toString('base64url');
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }),
    });
    if (!res.ok) throw new Error(`FCM auth failed: ${res.status}`);
    const j = await res.json();
    cached = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
    return cached.token;
  }

  // Returns false if the device token is no longer valid (caller should delete it).
  async function send(deviceToken, { title, body, url, tag }) {
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        message: {
          token: deviceToken,
          notification: { title, body },
          data: { url: url || '/' },
          android: { priority: 'high', notification: { tag, channel_id: 'gate', default_sound: true } },
          apns: { headers: { 'apns-priority': '10' }, payload: { aps: { sound: 'default', 'thread-id': tag || 'gatepass' } } },
        },
      }),
    });
    if (res.status === 404 || res.status === 400) {
      const err = await res.json().catch(() => ({}));
      const code = err?.error?.details?.find((d) => d.errorCode)?.errorCode;
      if (res.status === 404 || code === 'UNREGISTERED' || code === 'INVALID_ARGUMENT') return false;
    }
    return true;
  }

  return { send };
}

module.exports = { createFcm };
