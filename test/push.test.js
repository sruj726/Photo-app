'use strict';
/* Web Push crypto + delivery, verified against a local mock push service that decrypts what it receives. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const push = require('../push.js');

// ---- a fake browser subscription (client ECDH key pair + 16-byte auth secret)
function fakeSubscription(endpoint) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    subscription: { endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } },
    privateKey: ecdh.getPrivateKey().toString('base64url'),
  };
}

// ---- mock push service: records requests, answers with a configurable status
const received = [];
let nextStatus = 201;
const mock = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => { received.push({ headers: req.headers, url: req.url, body: Buffer.concat(chunks) }); res.writeHead(nextStatus); res.end(); });
});
let mockBase;
before(async () => { await new Promise((r) => mock.listen(0, '127.0.0.1', r)); mockBase = `http://127.0.0.1:${mock.address().port}`; });
after(() => mock.close());

test('keys: generated once, persisted, reloaded', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vapid-'));
  const file = path.join(dir, 'vapid.json');
  const k1 = push.loadOrCreateKeys(file);
  const k2 = push.loadOrCreateKeys(file);
  assert.deepEqual(k1, k2);
  assert.equal(Buffer.from(k1.publicKey, 'base64url').length, 65, 'uncompressed P-256 point');
  assert.equal(Buffer.from(k1.privateKey, 'base64url').length, 32);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('VAPID JWT verifies with the public key and carries aud/sub/exp', () => {
  const keys = push.generateKeys();
  const jwt = push.vapidJwt('https://push.example', 'mailto:ops@example.com', keys);
  const [h, p, s] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { typ: 'JWT', alg: 'ES256' });
  const payload = JSON.parse(Buffer.from(p, 'base64url'));
  assert.equal(payload.aud, 'https://push.example');
  assert.equal(payload.sub, 'mailto:ops@example.com');
  assert.ok(payload.exp > Date.now() / 1000 && payload.exp <= Date.now() / 1000 + 12 * 3600 + 5);
  const pub = Buffer.from(keys.publicKey, 'base64url');
  const pubKey = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: pubKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
});

test('encrypt -> decrypt round trip (RFC 8291 aes128gcm)', () => {
  const { subscription, privateKey } = fakeSubscription('https://push.example/abc');
  const body = push.encrypt('{"hello":"wörld"}', subscription);
  assert.equal(body.readUInt32BE(16), 4096, 'record size');
  assert.equal(body[20], 65, 'key id length');
  assert.equal(push.decrypt(body, privateKey, subscription), '{"hello":"wörld"}');
  // Tampering must fail authentication.
  const tampered = Buffer.from(body); tampered[tampered.length - 1] ^= 1;
  assert.throws(() => push.decrypt(tampered, privateKey, subscription));
  // Two encryptions of the same text differ (fresh salt + ephemeral key).
  assert.notEqual(push.encrypt('x', subscription).toString('hex'), push.encrypt('x', subscription).toString('hex'));
});

test('send: correct headers, VAPID auth for the endpoint origin, payload decryptable by the client', async () => {
  const keys = push.generateKeys();
  const { subscription, privateKey } = fakeSubscription(`${mockBase}/send/xyz`);
  const r = await push.send(subscription, { title: 'Goa', body: '3 new photos', url: '/t/abc' }, keys, { subject: 'mailto:ops@example.com', ttl: 60 });
  assert.equal(r.status, 201);
  const m = received.at(-1);
  assert.equal(m.url, '/send/xyz');
  assert.equal(m.headers['content-encoding'], 'aes128gcm');
  assert.equal(m.headers['content-type'], 'application/octet-stream');
  assert.equal(m.headers.ttl, '60');
  assert.match(m.headers.authorization, new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${keys.publicKey}$`));
  const jwt = m.headers.authorization.match(/t=([^,]+)/)[1];
  assert.equal(JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url')).aud, mockBase);
  assert.deepEqual(JSON.parse(push.decrypt(m.body, privateKey, subscription)), { title: 'Goa', body: '3 new photos', url: '/t/abc' });
});

test('send: reports push-service errors without throwing', async () => {
  nextStatus = 410;
  const keys = push.generateKeys();
  const { subscription } = fakeSubscription(`${mockBase}/gone`);
  const r = await push.send(subscription, { title: 'x' }, keys, { subject: 'mailto:ops@example.com' });
  assert.equal(r.status, 410);
  nextStatus = 201;
  await assert.rejects(push.send({ endpoint: 'not a url', keys: subscription.keys }, {}, keys, { subject: 'mailto:x' }), /Invalid endpoint/);
});
