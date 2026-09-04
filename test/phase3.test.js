'use strict';
/* Phase 3: keep originals, server-side thumbnails + conversion (sharp), video, chunked uploads. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'triplink-p3-'));
process.env.PORT = '0';
process.env.LOG = 'off';
const { server, db, DATA_DIR, sweepExpired } = require('../server.js');
const media = require('../src/media.js');

let base;
before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
// Minimal WebM: EBML header + Segment element (enough for the sniffer; browsers would reject it, which is fine here).
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01, 0x42, 0xf2, 0x81, 0x04, 0x42, 0xf3, 0x81, 0x08, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d, 0x42, 0x87, 0x81, 0x02, 0x42, 0x85, 0x81, 0x02, 0x18, 0x53, 0x80, 0x67, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]), Buffer.alloc(1024, 7)]);
const MP4 = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from('ftypisom'), Buffer.from([0x00, 0x00, 0x02, 0x00]), Buffer.from('isomiso2mp41'), Buffer.alloc(2048, 3)]);

const j = async (method, url, { json, body, headers = {}, token } = {}) => {
  const opts = { method, headers: { ...headers } };
  if (token) opts.headers['X-Member-Token'] = token;
  if (json !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(json); }
  if (body !== undefined) opts.body = body;
  const res = await fetch(base + url, opts);
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, headers: res.headers, data: ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
};
const createTrip = async (name = 'Trip') => { const r = await j('POST', '/api/trips', { json: { name, creatorName: 'Owner' } }); return { trip: r.data.trip, owner: r.data.member }; };
const upload = (code, token, bytes, meta) => j('POST', `/api/trips/${code}/photos`, { body: bytes, token, headers: { 'Content-Type': 'application/octet-stream', ...(meta ? { 'X-Photo-Meta': JSON.stringify(meta) } : {}) } });
const tripDir = (code) => path.join(DATA_DIR, 'photos', db.prepare('SELECT id FROM trips WHERE code = ?').get(code).id);

test('trip exposes limits and keepOriginals; owner can toggle it', async () => {
  const { trip, owner } = await createTrip();
  assert.equal(trip.keepOriginals, false);
  assert.equal(trip.limits.videoBytes, 200 * 1024 * 1024);
  assert.equal(trip.limits.chunkBytes, 4 * 1024 * 1024);
  const r = await j('PATCH', `/api/trips/${trip.code}`, { token: owner.token, json: { keepOriginals: true } });
  assert.equal(r.data.trip.keepOriginals, true);
  assert.equal((await j('GET', `/api/trips/${trip.code}`)).data.trip.keepOriginals, true);
});

test('originals: rejected when the trip does not keep them, stored + served + zipped when it does', async () => {
  const { trip, owner } = await createTrip('Orig');
  const up = await upload(trip.code, owner.token, JPEG);
  assert.equal(up.status, 201);
  const photo = up.data.photo;
  assert.equal(photo.originalUrl, null);
  const big = Buffer.concat([JPEG, Buffer.alloc(5000, 1)]);   // "original" = different bytes, still a JPEG by magic
  assert.equal((await j('POST', `/api/trips/${trip.code}/photos/${photo.id}/original`, { token: owner.token, body: big })).status, 400);

  await j('PATCH', `/api/trips/${trip.code}`, { token: owner.token, json: { keepOriginals: true } });
  const guest = (await j('POST', `/api/trips/${trip.code}/join`, { json: { name: 'G' } })).data.member;
  assert.equal((await j('POST', `/api/trips/${trip.code}/photos/${photo.id}/original`, { token: guest.token, body: big })).status, 403, 'only the uploader');
  const o = await j('POST', `/api/trips/${trip.code}/photos/${photo.id}/original`, { token: owner.token, body: big });
  assert.equal(o.status, 200);
  assert.equal(o.data.originalSize, big.length);
  const listed = (await j('GET', `/api/trips/${trip.code}/photos`, { token: owner.token })).data.photos[0];
  assert.equal(listed.originalUrl, `/api/trips/${trip.code}/photos/${photo.id}/original`);
  assert.equal(listed.originalSize, big.length);
  const got = await fetch(base + listed.originalUrl + '?download=1');
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'image/jpeg');
  assert.equal(Buffer.compare(Buffer.from(await got.arrayBuffer()), big), 0);
  assert.ok(fs.existsSync(path.join(tripDir(trip.code), `${photo.id}.orig.jpg`)));

  // ZIP now carries the original bytes.
  const zip = Buffer.from(await (await fetch(`${base}/api/trips/${trip.code}/download.zip`, { headers: { 'X-Member-Token': owner.token } })).arrayBuffer());
  const nameLen = zip.readUInt16LE(26);
  assert.equal(zip.readUInt32LE(18), big.length, 'first entry is the original size');
  assert.equal(Buffer.compare(zip.subarray(30 + nameLen, 30 + nameLen + big.length), big), 0);

  // Delete removes main, thumb and original.
  await j('DELETE', `/api/trips/${trip.code}/photos/${photo.id}`, { token: owner.token });
  assert.deepEqual(fs.readdirSync(tripDir(trip.code)), []);
});

test('sharp: server-side thumbnail and dimensions; AVIF/HEIC converted to JPEG (original kept when enabled)', { skip: !media.available() && 'sharp not installed' }, async () => {
  const sharp = require('sharp');
  const png = await sharp({ create: { width: 900, height: 600, channels: 3, background: '#3355ff' } }).png().toBuffer();
  const { trip, owner } = await createTrip('Sharp');
  const up = await upload(trip.code, owner.token, png);
  assert.equal(up.status, 201);
  assert.equal(up.data.photo.hasThumb, true, 'thumbnail made on the server');
  assert.equal(up.data.photo.width, 900);
  assert.equal(up.data.photo.height, 600);
  const thumb = await fetch(base + up.data.photo.thumbUrl);
  assert.equal(thumb.headers.get('content-type'), 'image/jpeg');
  const tm = await sharp(Buffer.from(await thumb.arrayBuffer())).metadata();
  assert.equal(tm.width, 480);
  assert.equal(tm.height, 320);

  // A format browsers cannot rely on (AVIF here; HEIC takes the identical path) is converted to JPEG.
  const avif = await sharp({ create: { width: 300, height: 200, channels: 3, background: '#ff8800' } }).avif({ quality: 40 }).toBuffer();
  assert.equal(avif.toString('ascii', 4, 8), 'ftyp');
  const conv = await upload(trip.code, owner.token, avif);
  assert.equal(conv.status, 201);
  assert.equal(conv.data.photo.mime, 'image/jpeg');
  assert.equal(conv.data.photo.originalUrl, null, 'originals off: converted bytes only');
  await j('PATCH', `/api/trips/${trip.code}`, { token: owner.token, json: { keepOriginals: true } });
  const avif2 = await sharp({ create: { width: 320, height: 200, channels: 3, background: '#00ff88' } }).avif({ quality: 40 }).toBuffer();
  const conv2 = await upload(trip.code, owner.token, avif2);
  assert.equal(conv2.data.photo.mime, 'image/jpeg');
  assert.match(conv2.data.photo.originalUrl, /\/original$/);
  const orig = await fetch(base + conv2.data.photo.originalUrl);
  assert.equal(orig.headers.get('content-type'), 'image/avif');
  assert.equal(Buffer.compare(Buffer.from(await orig.arrayBuffer()), avif2), 0);
});

test('video: sniffed by magic bytes, stored with kind/duration, no thumb until the client posts a poster', async () => {
  const { trip, owner } = await createTrip('Video');
  const v = await upload(trip.code, owner.token, WEBM, { duration: 4.2, width: 640, height: 480 });
  assert.equal(v.status, 201);
  assert.equal(v.data.photo.kind, 'video');
  assert.equal(v.data.photo.mime, 'video/webm');
  assert.equal(v.data.photo.duration, 4.2);
  assert.equal(v.data.photo.thumbUrl, null);
  const t = await j('POST', `/api/trips/${trip.code}/photos/${v.data.photo.id}/thumb`, { token: owner.token, body: JPEG });
  assert.equal(t.status, 200);
  const listed = (await j('GET', `/api/trips/${trip.code}/photos`, { token: owner.token })).data.photos[0];
  assert.ok(listed.thumbUrl.endsWith('/thumb'));
  const m = await upload(trip.code, owner.token, MP4);
  assert.equal(m.data.photo.mime, 'video/mp4');
  const served = await fetch(base + m.data.photo.url);
  assert.equal(served.headers.get('content-type'), 'video/mp4');
  assert.equal((await upload(trip.code, owner.token, Buffer.from('RIFF....AVI LIST'))).status, 415, 'unknown containers rejected');
});

test('chunked upload: init, out-of-order chunk 409, status, complete -> photo; dedupe; abort; stale sweep', async () => {
  const { trip, owner } = await createTrip('Chunks');
  const file = Buffer.concat([JPEG, Buffer.alloc(10 * 1024, 9)]);
  assert.equal((await j('POST', `/api/trips/${trip.code}/uploads`, { token: owner.token, json: { size: 0 } })).status, 400);
  assert.equal((await j('POST', `/api/trips/${trip.code}/uploads`, { token: owner.token, json: { size: 300 * 1024 * 1024 } })).status, 413);
  const init = await j('POST', `/api/trips/${trip.code}/uploads`, { token: owner.token, json: { size: file.length, takenAt: 1700000000000, width: 1, height: 1 } });
  assert.equal(init.status, 201);
  const { uploadId } = init.data;
  const half = Math.floor(file.length / 2);
  assert.equal((await j('POST', `/api/trips/${trip.code}/uploads/${uploadId}/complete`, { token: owner.token })).status, 409, 'nothing received yet');
  const c1 = await j('PUT', `/api/trips/${trip.code}/uploads/${uploadId}?offset=0`, { token: owner.token, body: file.subarray(0, half) });
  assert.equal(c1.status, 200);
  assert.equal(c1.data.received, half);
  const wrong = await j('PUT', `/api/trips/${trip.code}/uploads/${uploadId}?offset=0`, { token: owner.token, body: file.subarray(0, half) });
  assert.equal(wrong.status, 409);
  assert.equal(wrong.data.received, half, 'client learns where to resume');
  const st = await j('GET', `/api/trips/${trip.code}/uploads/${uploadId}`, { token: owner.token });
  assert.equal(st.data.received, half);
  const guest = (await j('POST', `/api/trips/${trip.code}/join`, { json: { name: 'G' } })).data.member;
  assert.equal((await j('GET', `/api/trips/${trip.code}/uploads/${uploadId}`, { token: guest.token })).status, 404, 'uploads are private to their member');
  assert.equal((await j('PUT', `/api/trips/${trip.code}/uploads/${uploadId}?offset=${half}`, { token: owner.token, body: file.subarray(half) })).status, 200);
  const done = await j('POST', `/api/trips/${trip.code}/uploads/${uploadId}/complete`, { token: owner.token });
  assert.equal(done.status, 201);
  assert.equal(done.data.photo.size, file.length);
  assert.equal(done.data.photo.takenAt, 1700000000000);
  assert.equal(done.data.photo.mime, 'image/jpeg');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM uploads').get().n, 0, 'upload record cleaned up');
  assert.deepEqual(fs.readdirSync(path.join(DATA_DIR, 'uploads')), [], 'part file removed');

  // Same bytes through the chunked path -> 409 duplicate, still cleaned up.
  const init2 = await j('POST', `/api/trips/${trip.code}/uploads`, { token: owner.token, json: { size: file.length } });
  await j('PUT', `/api/trips/${trip.code}/uploads/${init2.data.uploadId}?offset=0`, { token: owner.token, body: file });
  const dup = await j('POST', `/api/trips/${trip.code}/uploads/${init2.data.uploadId}/complete`, { token: owner.token });
  assert.equal(dup.status, 409);
  assert.equal(dup.data.photo.id, done.data.photo.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM uploads').get().n, 0);

  // Abort + stale sweep.
  const init3 = await j('POST', `/api/trips/${trip.code}/uploads`, { token: owner.token, json: { size: 100 } });
  assert.equal((await j('DELETE', `/api/trips/${trip.code}/uploads/${init3.data.uploadId}`, { token: owner.token })).status, 200);
  const init4 = await j('POST', `/api/trips/${trip.code}/uploads`, { token: owner.token, json: { size: 100 } });
  db.prepare('UPDATE uploads SET updated_at = ? WHERE id = ?').run(Date.now() - 3 * 86400000, init4.data.uploadId);
  await sweepExpired();
  assert.equal((await j('GET', `/api/trips/${trip.code}/uploads/${init4.data.uploadId}`, { token: owner.token })).status, 404);
  assert.deepEqual(fs.readdirSync(path.join(DATA_DIR, 'uploads')), []);
});

test('health reports the storage backend and image processing mode', async () => {
  const h = (await j('GET', '/api/health')).data;
  assert.equal(h.storage, 'local');
  assert.equal(h.imageProcessing, media.available() ? 'sharp' : 'client-only');
});
