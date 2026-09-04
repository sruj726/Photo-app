'use strict';
/* Phase 7: opt-in AI flags, gated metadata (sharpness, location), person tagging via external command. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'triplink-p7-'));
process.env.PORT = '0';
process.env.LOG = 'off';
process.env.TAGGER_CMD = `node ${path.join(__dirname, 'fixtures', 'fake-tagger.js')}`;
const { server, DATA_DIR, tagPeople, db } = require('../server.js');

let base;
before(async () => { await new Promise((r) => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`; });
after(async () => { await new Promise((r) => server.close(r)); fs.rmSync(DATA_DIR, { recursive: true, force: true }); });

const JPEG = fs.readFileSync(path.join(__dirname, 'fixtures', 'tiny.jpg'));
const j = async (method, url, { json, body, headers = {}, token } = {}) => {
  const opts = { method, headers: { ...headers } };
  if (token) opts.headers['X-Member-Token'] = token;
  if (json !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(json); }
  if (body !== undefined) opts.body = body;
  const res = await fetch(base + url, opts);
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, data: ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
};
const createTrip = async () => { const r = await j('POST', '/api/trips', { json: { name: 'AI', creatorName: 'O' } }); return { trip: r.data.trip, owner: r.data.member }; };
const upload = (code, token, bytes, meta) => j('POST', `/api/trips/${code}/photos`, { body: bytes, token, headers: { 'X-Photo-Meta': JSON.stringify(meta || {}) } });

test('ai flags default off; organiser toggles individually; validation', async () => {
  const { trip, owner } = await createTrip();
  assert.deepEqual(trip.ai, { faces: false, bestShot: false, people: false, map: false });
  assert.equal((await j('PATCH', `/api/trips/${trip.code}`, { token: owner.token, json: { ai: 'yes' } })).status, 400);
  const r = await j('PATCH', `/api/trips/${trip.code}`, { token: owner.token, json: { ai: { map: true } } });
  assert.deepEqual(r.data.trip.ai, { faces: false, bestShot: false, people: false, map: true });
  const r2 = await j('PATCH', `/api/trips/${trip.code}`, { token: owner.token, json: { ai: { bestShot: true, map: false } } });
  assert.deepEqual(r2.data.trip.ai, { faces: false, bestShot: true, people: false, map: false });
});

test('sharpness and location are stored only when the trip opted in', async () => {
  const { trip, owner } = await createTrip();
  const meta = { sharpness: 123.4, lat: 15.4989, lng: 73.8278 };
  const off = await upload(trip.code, owner.token, JPEG, meta);
  assert.equal(off.data.photo.sharpness, null); assert.equal(off.data.photo.lat, null); assert.equal(off.data.photo.lng, null);
  await j('PATCH', `/api/trips/${trip.code}`, { token: owner.token, json: { ai: { bestShot: true, map: true } } });
  const on = await upload(trip.code, owner.token, Buffer.concat([JPEG, Buffer.from('1')]), meta);
  assert.equal(on.data.photo.sharpness, 123.4); assert.equal(on.data.photo.lat, 15.4989); assert.equal(on.data.photo.lng, 73.8278);
  const bad = await upload(trip.code, owner.token, Buffer.concat([JPEG, Buffer.from('2')]), { lat: 95, lng: 10, sharpness: 'x' });
  assert.equal(bad.data.photo.lat, null); assert.equal(bad.data.photo.sharpness, null);
  const listed = (await j('GET', `/api/trips/${trip.code}/photos`, { token: owner.token })).data.photos;
  assert.equal(listed.find((p) => p.id === on.data.photo.id).lat, 15.4989);
  // chunked path carries the same metadata
  const init = await j('POST', `/api/trips/${trip.code}/uploads`, { token: owner.token, json: { size: JPEG.length + 1, sharpness: 9, lat: 1, lng: 2 } });
  await fetch(`${base}/api/trips/${trip.code}/uploads/${init.data.uploadId}?offset=0`, { method: 'PUT', headers: { 'X-Member-Token': owner.token }, body: Buffer.concat([JPEG, Buffer.from('3')]) });
  const done = await j('POST', `/api/trips/${trip.code}/uploads/${init.data.uploadId}/complete`, { token: owner.token });
  assert.equal(done.data.photo.sharpness, 9); assert.equal(done.data.photo.lat, 1);
});

test('tag-people: only opted-in trips, external command output stored, failures retried up to 3 times', async () => {
  const a = await createTrip(), b = await createTrip();
  await j('PATCH', `/api/trips/${a.trip.code}`, { token: a.owner.token, json: { ai: { people: true } } });
  const pa = (await upload(a.trip.code, a.owner.token, Buffer.concat([JPEG, Buffer.alloc(3, 1)]))).data.photo;   // size % 5 = deterministic count
  const pb = (await upload(b.trip.code, b.owner.token, Buffer.concat([JPEG, Buffer.alloc(3, 2)]))).data.photo;
  const r = await tagPeople();
  assert.equal(r.tagged, 1, 'only the opted-in trip is tagged');
  const expected = (JPEG.length + 3) % 5;
  assert.equal((await j('GET', `/api/trips/${a.trip.code}/photos`, { token: a.owner.token })).data.photos[0].peopleCount, expected);
  assert.equal((await j('GET', `/api/trips/${b.trip.code}/photos`, { token: b.owner.token })).data.photos[0].peopleCount, null);
  assert.deepEqual(await tagPeople(), { tagged: 0, failed: 0, remaining: 0 }, 'idempotent');
  // Failing tagger: attempts counted, gives up after 3
  process.env.FAKE_TAGGER_FAIL = '1';
  await upload(a.trip.code, a.owner.token, Buffer.concat([JPEG, Buffer.alloc(4, 9)]));
  for (let i = 1; i <= 3; i++) { const rr = await tagPeople(); assert.equal(rr.failed, 1, `attempt ${i} fails`); }
  assert.deepEqual(await tagPeople(), { tagged: 0, failed: 0, remaining: 0 }, 'given up after 3 attempts');
  delete process.env.FAKE_TAGGER_FAIL;
  assert.equal(db.prepare('SELECT people_attempts FROM photos WHERE trip_id = (SELECT id FROM trips WHERE code = ?) AND people_count IS NULL').get(a.trip.code).people_attempts, 3);
  void pa; void pb;
});
