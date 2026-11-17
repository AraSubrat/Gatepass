// Delivers events to users:
//  1. Server-Sent Events to any open app screen (instant, no setup).
//  2. Web Push to the installed website/PWA, when VAPID keys are configured.
//  3. Native push to the Android app (Firebase) and iOS app (Apple APNs), when configured.
const { createFcm } = require('./fcm');
const { createApns } = require('./apns');

let webpush = null;

function createNotifier(db) {
  const streams = new Map(); // userId -> Set<res>
  const fcm = createFcm();
  const apns = createApns();
  const pushEnabled = Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
  if (pushEnabled) {
    webpush = require('web-push');
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY,
    );
  }

  function subscribe(userId, res) {
    if (!streams.has(userId)) streams.set(userId, new Set());
    streams.get(userId).add(res);
    return () => {
      const set = streams.get(userId);
      set?.delete(res);
      if (set && set.size === 0) streams.delete(userId);
    };
  }

  // event: short type for the app ("visitor", "booking", ...); push: optional {title, body, url}
  function toUsers(userIds, event, data, push) {
    for (const id of new Set(userIds)) {
      for (const res of streams.get(id) || []) {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`);
      }
      if (push && pushEnabled) sendPush(id, push);
      if (push && (fcm || apns)) sendNative(id, push);
    }
  }

  function sendPush(userId, payload) {
    const subs = db.all('SELECT endpoint, keys FROM push_subscriptions WHERE user_id = ?', userId);
    for (const s of subs) {
      webpush
        .sendNotification({ endpoint: s.endpoint, keys: JSON.parse(s.keys) }, JSON.stringify(payload), { TTL: 300, urgency: 'high' })
        .catch((err) => {
          if (err.statusCode === 404 || err.statusCode === 410) {
            db.run('DELETE FROM push_subscriptions WHERE endpoint = ?', s.endpoint);
          }
        });
    }
  }

  function sendNative(userId, payload) {
    for (const { token, platform } of db.all('SELECT token, platform FROM native_push_tokens WHERE user_id = ?', userId)) {
      // iOS devices register an APNs token; Android registers an FCM token.
      const sender = platform === 'ios' ? (apns || null) : fcm;
      if (!sender) continue;
      sender.send(token, payload)
        .then((valid) => { if (!valid) db.run('DELETE FROM native_push_tokens WHERE token = ?', token); })
        .catch((err) => console.error(`Push to ${platform} failed:`, err.message));
    }
  }

  const residentsOf = (flatId) =>
    db.all("SELECT id FROM users WHERE flat_id = ? AND status = 'active'", flatId).map((r) => r.id);
  const guards = () =>
    db.all("SELECT id FROM users WHERE role IN ('guard') AND status = 'active'").map((r) => r.id);
  const admins = () =>
    db.all("SELECT id FROM users WHERE role = 'admin' AND status = 'active'").map((r) => r.id);

  return {
    subscribe, toUsers, residentsOf, guards, admins,
    pushEnabled, nativePushEnabled: { android: Boolean(fcm), ios: Boolean(apns) }, publicKey: process.env.VAPID_PUBLIC_KEY || null,
  };
}

module.exports = { createNotifier };
