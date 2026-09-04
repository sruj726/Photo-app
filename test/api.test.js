'use strict';
/* End-to-end API tests: boots the real server on a random port with a temp data dir. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'triplink-test-'));
process.env.PORT = '0';
const { server } = require('../server.js');

let base;
before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

// A tiny valid JPEG (1x1) so the magic-byte sniffer accepts it.
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const j = async (method, url, { json, body, headers = {}, token } = {}) => {
  const opts = { method, headers: { ...headers } };
  if (token) opts.headers['X-Member-Token'] = token;
  if (json !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(json); }
  if (body !== undefined) opts.body = body;
  const res = await fetch(base + url, opts);
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, headers: res.headers, data: ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
};

let trip, owner, guest, photo;

test('health + shell', async () => {
  assert.equal((await j('GET', '/api/health')).status, 200);
  const home = await fetch(base + '/');
  assert.equal(home.status, 200);
  assert.match(await home.text(), /TripLink/);
  const deep = await fetch(base + '/t/abc12345');
  assert.equal(deep.status, 200, 'deep links serve the SPA shell');
  assert.equal((await fetch(base + '/manifest.webmanifest')).headers.get('content-type'), 'application/manifest+json');
});

test('create trip returns code + owner token', async () => {
  const r = await j('POST', '/api/trips', { json: { name: 'Goa 2026', creatorName: 'Srujan' } });
  assert.equal(r.status, 201);
  trip = r.data.trip; owner = r.data.member;
  assert.match(trip.code, /^[a-z0-9]{10}$/);
  assert.equal(trip.name, 'Goa 2026');
  assert.equal(owner.isOwner, true);
  assert.ok(owner.token.length > 20);
});

test('public trip info works without token, listing does not', async () => {
  const info = await j('GET', `/api/trips/${trip.code}`);
  assert.equal(info.status, 200);
  assert.equal(info.data.trip.memberCount, 1);
  assert.equal((await j('GET', `/api/trips/${trip.code}/photos`)).status, 401);
  assert.equal((await j('GET', '/api/trips/doesnotexist')).status, 404);
  assert.equal((await j('GET', '/api/trips/x')).status, 404, 'codes shorter than 6 chars are rejected');
  assert.equal((await j('GET', '/api/trips/ABCDEFGHJK')).status, 404, 'uppercase is not a valid code');
});

test('guest joins via code', async () => {
  const r = await j('POST', `/api/trips/${trip.code}/join`, { json: { name: 'Priya' } });
  assert.equal(r.status, 201);
  guest = r.data.member;
  assert.equal(guest.isOwner, false);
  const me = await j('GET', `/api/trips/${trip.code}/me`, { token: guest.token });
  assert.equal(me.data.member.name, 'Priya');
  const members = await j('GET', `/api/trips/${trip.code}/members`, { token: guest.token });
  assert.deepEqual(members.data.members.map((m) => m.name), ['Srujan', 'Priya']);
});

test('upload photo (sniffed as JPEG) + thumbnail', async () => {
  const r = await j('POST', `/api/trips/${trip.code}/photos`, {
    body: JPEG, token: guest.token,
    headers: { 'Content-Type': 'application/octet-stream', 'X-Photo-Meta': JSON.stringify({ takenAt: 1700000000000, width: 1, height: 1 }) },
  });
  assert.equal(r.status, 201);
  photo = r.data.photo;
  assert.equal(photo.mime, 'image/jpeg');
  assert.equal(photo.memberName, 'Priya');
  assert.equal(photo.takenAt, 1700000000000);
  assert.ok(photo.thumbUrl.endsWith('/file'), 'no thumb yet -> falls back to full file');

  const t = await j('POST', `/api/trips/${trip.code}/photos/${photo.id}/thumb`, { body: JPEG, token: guest.token, headers: { 'Content-Type': 'image/jpeg' } });
  assert.equal(t.status, 200);
  const list = await j('GET', `/api/trips/${trip.code}/photos`, { token: owner.token });
  assert.equal(list.data.photos.length, 1);
  assert.ok(list.data.photos[0].thumbUrl.endsWith('/thumb'));

  // Files are served with the right type; download=1 sets a filename.
  const file = await fetch(base + photo.url + '?download=1');
  assert.equal(file.headers.get('content-type'), 'image/jpeg');
  assert.match(file.headers.get('content-disposition'), /attachment; filename="\d{4}-\d{2}-\d{2}T[\d-]+_Priya_[0-9a-f]{8}\.jpg"/);
  assert.equal(Buffer.compare(Buffer.from(await file.arrayBuffer()), JPEG), 0);
});

test('rejects non-images, oversize declarations and strangers', async () => {
  const bad = await j('POST', `/api/trips/${trip.code}/photos`, { body: Buffer.from('<html>not an image</html>'), token: guest.token });
  assert.equal(bad.status, 415);
  const big = await fetch(base + `/api/trips/${trip.code}/photos`, { method: 'POST', headers: { 'X-Member-Token': guest.token, 'Content-Length': String(30 * 1024 * 1024) }, body: JPEG, duplex: 'half' }).catch(() => ({ status: 413 }));
  assert.equal(big.status, 413);
  const stranger = await j('POST', `/api/trips/${trip.code}/photos`, { body: JPEG, token: 'not-a-real-token' });
  assert.equal(stranger.status, 401);
  // PNG accepted too
  const png = await j('POST', `/api/trips/${trip.code}/photos`, { body: PNG, token: owner.token });
  assert.equal(png.status, 201);
  assert.equal(png.data.photo.mime, 'image/png');
});

test('download all -> valid zip with every photo', async () => {
  const r = await fetch(base + `/api/trips/${trip.code}/download.zip`, { headers: { 'X-Member-Token': guest.token } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/zip');
  assert.match(r.headers.get('content-disposition'), /Goa_2026_photos\.zip/);
  const buf = Buffer.from(await r.arrayBuffer());
  assert.equal(buf.readUInt32LE(0), 0x04034b50, 'local header signature');
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd > 0, 'has end-of-central-directory');
  assert.equal(buf.readUInt16LE(eocd + 10), 2, 'two entries');
  // First entry's stored bytes must equal the JPEG exactly (STORE method) and its CRC must match.
  const nameLen = buf.readUInt16LE(26);
  const data = buf.subarray(30 + nameLen, 30 + nameLen + JPEG.length);
  assert.equal(Buffer.compare(data, JPEG), 0);
  assert.equal(buf.readUInt32LE(14) >>> 0, zlib.crc32(JPEG) >>> 0, 'CRC32 matches zlib');
});

test('delete permissions: uploader or owner only', async () => {
  const r0 = await j('POST', `/api/trips/${trip.code}/join`, { json: { name: 'Random' } });
  const random = r0.data.member;
  assert.equal((await j('DELETE', `/api/trips/${trip.code}/photos/${photo.id}`, { token: random.token })).status, 403);
  assert.equal((await j('DELETE', `/api/trips/${trip.code}/photos/${photo.id}`, { token: owner.token })).status, 200);
  const list = await j('GET', `/api/trips/${trip.code}/photos`, { token: owner.token });
  assert.equal(list.data.photos.length, 1);
  assert.equal((await fetch(base + photo.url)).status, 404);
});

test('rate limit answers 429', async () => {
  let last = 200;
  for (let i = 0; i < 300 && last !== 429; i++) last = (await fetch(base + '/api/health')).status;
  assert.equal(last, 429);
});
