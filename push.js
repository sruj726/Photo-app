'use strict';
/**
 * Web Push with nothing but node:crypto – VAPID (RFC 8292) + aes128gcm payload encryption (RFC 8291).
 *
 *   const push = require('./push');
 *   const keys = push.loadOrCreateKeys('/data/vapid.json');   // { publicKey, privateKey } (base64url, raw P-256)
 *   await push.send(subscription, { title, body, url }, keys, { subject: 'mailto:you@example.com', ttl: 3600 });
 *
 * `subscription` is the object the browser's PushManager.subscribe() returns:
 *   { endpoint, keys: { p256dh, auth } }
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s), 'base64url');

function generateKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}

function loadOrCreateKeys(file) {
  try {
    const k = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (k.publicKey && k.privateKey) return k;
  } catch { /* create below */ }
  const keys = generateKeys();
  fs.writeFileSync(file, JSON.stringify(keys, null, 2), { mode: 0o600 });
  return keys;
}

function privateKeyObject(keys) {
  const pub = fromB64u(keys.publicKey);
  return crypto.createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: keys.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
    format: 'jwk',
  });
}

/** Signed VAPID JWT for the push service origin (`aud`). */
function vapidJwt(aud, subject, keys, expiresInSeconds = 12 * 3600) {
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + expiresInSeconds, sub: subject }));
  const signature = crypto.sign('sha256', Buffer.from(`${header}.${payload}`), { key: privateKeyObject(keys), dsaEncoding: 'ieee-p1363' });
  return `${header}.${payload}.${b64u(signature)}`;
}

/** RFC 8291 encryption. Returns the aes128gcm body (header + ciphertext). */
function encrypt(plaintext, subscription) {
  const clientPub = fromB64u(subscription.keys.p256dh);
  const auth = fromB64u(subscription.keys.auth);
  if (clientPub.length !== 65 || auth.length !== 16) throw new Error('Invalid subscription keys');
  const local = crypto.createECDH('prime256v1');
  local.generateKeys();
  const localPub = local.getPublicKey();
  const shared = local.computeSecret(clientPub);
  const authInfo = Buffer.concat([Buffer.from('WebPush: info\0'), clientPub, localPub]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, auth, authInfo, 32));
  const salt = crypto.randomBytes(16);
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const record = Buffer.concat([Buffer.from(plaintext), Buffer.from([0x02])]);   // 0x02 = last record delimiter
  const ct = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(16 + 4 + 1 + 65);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);          // record size
  header[20] = 65;                          // key id length
  localPub.copy(header, 21);
  return Buffer.concat([header, ct]);
}

/** Mirror of encrypt(), used by tests and by anyone verifying deliveries. */
function decrypt(body, clientPrivateKeyB64u, subscription) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const serverPub = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const client = crypto.createECDH('prime256v1');
  client.setPrivateKey(fromB64u(clientPrivateKeyB64u));
  const clientPub = fromB64u(subscription.keys.p256dh);
  const shared = client.computeSecret(serverPub);
  const authInfo = Buffer.concat([Buffer.from('WebPush: info\0'), clientPub, serverPub]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, fromB64u(subscription.keys.auth), authInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([decipher.update(ct.subarray(0, ct.length - 16)), decipher.final()]);
  const delim = plain.lastIndexOf(0x02);
  return plain.subarray(0, delim).toString('utf8');
}

/** POST an encrypted notification. Resolves { status, body }. Never throws on HTTP errors. */
function send(subscription, payload, keys, { subject, ttl = 24 * 3600, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(subscription.endpoint); } catch { return reject(new Error('Invalid endpoint')); }
    const body = encrypt(JSON.stringify(payload), subscription);
    const jwt = vapidJwt(url.origin, subject, keys);
    const mod = url.protocol === 'http:' ? http : https;
    const req = mod.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        'Content-Length': body.length,
        TTL: String(ttl),
        Urgency: 'normal',
        Authorization: `vapid t=${jwt}, k=${keys.publicKey}`,
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => { req.destroy(new Error('Push request timed out')); });
    req.on('error', reject);
    req.end(body);
  });
}

module.exports = { generateKeys, loadOrCreateKeys, vapidJwt, encrypt, decrypt, send, privateKeyObject };
