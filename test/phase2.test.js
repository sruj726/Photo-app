'use strict';
/* Phase 2 server side: push subscriptions, batched "new photos" delivery, recaps, base URL. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'triplink-p2-'));
process.env.PORT = '0';
process.env.LOG = 'off';
process.env.PUSH_BATCH_MS = '60000';           // never fires on its own during the test; we flush explicitly
process.env.RECAP_AFTER_MS = String(48 * 3600 * 1000);
process.env.TRIPLINK_BASE_URL = 'https://photos.example.com/';
const { server, db, DATA_DIR, flushPhotoPush, sendRecaps, vapidKeys } = require('../server.js');
const webpush = require('../push.js');

// ---- mock push service that decrypts what it receives
const deliveries = [];                       // { endpoint, headers, payload }
const clientKeys = new Map();                // endpoint -> { privateKey, subscription }
let statusFor = () => 201;
const mock = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const endpoint = `http://127.0.0.1:${mock.address().port}${req.url}`;
    const ck = clientKeys.get(endpoint);
    const body = Buffer.concat(chunks);
    const payload = ck ? JSON.parse(webpush.decrypt(body, ck.privateKey, ck.subscription)) : null;
    deliveries.push({ endpoint, headers: req.headers, payload });
    res.writeHead(statusFor(req.url)); res.end();
  });
});

let base, mockBase;
before(async () => {
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  mockBase = `http://127.0.0.1:${mock.address().port}`;
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  mock.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const j = async (method, url, { json, body, headers = {}, token } = {}) => {
  const opts = { method, headers: { ...headers } };
  if (token) opts.headers['X-Member-Token'] = token;
  if (json !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(json); }
  if (body !== undefined) opts.body = body;
  const res = await fetch(base + url, opts);
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, data: ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
};
function fakeSubscription(name) {
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  const endpoint = `${mockBase}/push/${name}`;
  const subscription = { endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } };
  clientKeys.set(endpoint, { privateKey: ecdh.getPrivateKey().toString('base64url'), subscription });
  return subscription;
}

let trip, owner, priya, arjun;

test('base URL from TRIPLINK_BASE_URL is exposed without a trailing slash', async () => {
  const r = await j('POST', '/api/trips', { json: { name: 'Goa', creatorName: 'Srujan' } });
  trip = r.data.trip; owner = r.data.member;
  assert.equal(trip.baseUrl, 'https://photos.example.com');
  priya = (await j('POST', `/api/trips/${trip.code}/join`, { json: { name: 'Priya' } })).data.member;
  arjun = (await j('POST', `/api/trips/${trip.code}/join`, { json: { name: 'Arjun' } })).data.member;
});

test('push key is public; subscribe validates keys and needs a member token', async () => {
  const k = await j('GET', '/api/push/key');
  assert.equal(k.status, 200);
  assert.equal(k.data.publicKey, vapidKeys.publicKey);
  assert.equal((await j('POST', `/api/trips/${trip.code}/push`, { json: { subscription: fakeSubscription('nobody') } })).status, 401);
  assert.equal((await j('POST', `/api/trips/${trip.code}/push`, { token: owner.token, json: { endpoint: 'ftp://x', keys: { p256dh: 'a', auth: 'b' } } })).status, 400);
  assert.equal((await j('POST', `/api/trips/${trip.code}/push`, { token: owner.token, json: { endpoint: `${mockBase}/bad`, keys: { p256dh: 'short', auth: 'short' } } })).status, 400);
  for (const [m, name] of [[owner, 'owner'], [priya, 'priya'], [arjun, 'arjun']]) {
    assert.equal((await j('POST', `/api/trips/${trip.code}/push`, { token: m.token, json: { subscription: fakeSubscription(name) } })).status, 201);
  }
  const status = await j('GET', `/api/trips/${trip.code}/push`, { token: priya.token });
  assert.equal(status.data.subscribed, true);
  // Re-subscribing the same endpoint updates instead of duplicating.
  const sub = clientKeys.get(`${mockBase}/push/priya`).subscription;
  assert.equal((await j('POST', `/api/trips/${trip.code}/push`, { token: priya.token, json: { subscription: sub } })).status, 201);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get().n, 3);
});

test('uploads are batched into one push per trip, excluding the uploaders', async () => {
  const up = (token, bytes) => j('POST', `/api/trips/${trip.code}/photos`, { body: bytes, token, headers: { 'Content-Type': 'application/octet-stream' } });
  assert.equal((await up(priya.token, JPEG)).status, 201);
  assert.equal((await up(priya.token, PNG)).status, 201);
  assert.equal((await up(owner.token, Buffer.concat([JPEG, Buffer.from([0])]))).status, 201);
  assert.equal(deliveries.length, 0, 'nothing sent before the batch window closes');
  const health = await j('GET', '/api/health');
  assert.equal(health.data.push.pendingTrips, 1);

  const tripId = db.prepare('SELECT id FROM trips WHERE code = ?').get(trip.code).id;
  const r = await flushPhotoPush(tripId);
  assert.deepEqual(r, { sent: 1, dropped: 0 });
  assert.equal(deliveries.length, 1);
  const d = deliveries[0];
  assert.equal(d.endpoint, `${mockBase}/push/arjun`, 'only the member who did not upload gets pinged');
  assert.equal(d.headers['content-encoding'], 'aes128gcm');
  assert.match(d.headers.authorization, /^vapid t=/);
  assert.equal(d.payload.title, 'Goa');
  assert.equal(d.payload.body, '3 new photos from Priya and Srujan');
  assert.equal(d.payload.url, `/t/${trip.code}?tab=photos`);
  assert.equal(await flushPhotoPush(tripId), null, 'flushing again is a no-op');
});

test('gone endpoints (410) are dropped from the table', async () => {
  statusFor = (url) => (url.endsWith('/owner') ? 410 : 201);
  await j('POST', `/api/trips/${trip.code}/photos`, { body: Buffer.concat([PNG, Buffer.from([1])]), token: arjun.token });
  const tripId = db.prepare('SELECT id FROM trips WHERE code = ?').get(trip.code).id;
  const r = await flushPhotoPush(tripId);
  assert.deepEqual(r, { sent: 1, dropped: 1 });   // priya sent, owner dropped, arjun excluded
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get().n, 2);
  statusFor = () => 201;
});

test('recap goes out once, 48h after the last upload, to everyone subscribed', async () => {
  deliveries.length = 0;
  assert.deepEqual(await sendRecaps(), [], 'too early');
  const later = Date.now() + 49 * 3600 * 1000;
  assert.deepEqual(await sendRecaps(later), [trip.code]);
  assert.equal(deliveries.length, 2);
  assert.match(deliveries[0].payload.title, /Goa: all the photos are in/);
  assert.match(deliveries[0].payload.body, /^4 photos from 3 people\. Get them all before /);
  assert.deepEqual(await sendRecaps(later + 1000), [], 'never twice');
});

test('unsubscribe removes the endpoint', async () => {
  const sub = clientKeys.get(`${mockBase}/push/priya`).subscription;
  assert.equal((await j('DELETE', `/api/trips/${trip.code}/push`, { token: priya.token, json: { endpoint: sub.endpoint } })).status, 200);
  assert.equal((await j('GET', `/api/trips/${trip.code}/push`, { token: priya.token })).data.subscribed, false);
});
