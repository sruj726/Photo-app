'use strict';
/* Phase 1: trip management, member management, link rotation, dedupe, retention, health. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'triplink-p1-'));
process.env.PORT = '0';
process.env.LOG = 'off';
const { server, db, DATA_DIR, sweepExpired } = require('../server.js');

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
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const DAY = 86400000;

const j = async (method, url, { json, body, headers = {}, token } = {}) => {
  const opts = { method, headers: { ...headers } };
  if (token) opts.headers['X-Member-Token'] = token;
  if (json !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(json); }
  if (body !== undefined) opts.body = body;
  const res = await fetch(base + url, opts);
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, headers: res.headers, data: ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
};
const createTrip = async (name = 'Test trip') => {
  const r = await j('POST', '/api/trips', { json: { name, creatorName: 'Owner' } });
  assert.equal(r.status, 201);
  return { trip: r.data.trip, owner: r.data.member };
};
const join = async (code, name) => (await j('POST', `/api/trips/${code}/join`, { json: { name } })).data.member;
const upload = (code, token, bytes) => j('POST', `/api/trips/${code}/photos`, { body: bytes, token, headers: { 'Content-Type': 'application/octet-stream' } });
const tripDir = (code) => path.join(DATA_DIR, 'photos', db.prepare('SELECT id FROM trips WHERE code = ?').get(code).id);

// ---------------------------------------------------------------- 1. trip management
test('PATCH trip: rename + dates, validation, owner only', async () => {
  const { trip, owner } = await createTrip('Old name');
  const guest = await join(trip.code, 'Guest');
  assert.equal((await j('PATCH', `/api/trips/${trip.code}`, { token: guest.token, json: { name: 'Hack' } })).status, 403);
  assert.equal((await j('PATCH', `/api/trips/${trip.code}`, { json: { name: 'Hack' } })).status, 401);

  const ok = await j('PATCH', `/api/trips/${trip.code}`, { token: owner.token, json: { name: 'Goa 2026', startDate: '2026-03-10', endDate: '2026-03-14' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.trip.name, 'Goa 2026');
  assert.equal(ok.data.trip.startDate, '2026-03-10');
  assert.equal(ok.data.trip.endDate, '2026-03-14');

  assert.equal((await j('PATCH', `/api/trips/${trip.code}`, { token: owner.token, json: { startDate: '10/03/2026' } })).status, 400, 'bad date format');
  assert.equal((await j('PATCH', `/api/trips/${trip.code}`, { token: owner.token, json: { startDate: '2026-03-20', endDate: '2026-03-14' } })).status, 400, 'end before start');
  // Clearing a date and a partial update keep the other fields.
  const cleared = await j('PATCH', `/api/trips/${trip.code}`, { token: owner.token, json: { endDate: null } });
  assert.equal(cleared.data.trip.endDate, null);
  assert.equal(cleared.data.trip.startDate, '2026-03-10');
  assert.equal(cleared.data.trip.name, 'Goa 2026');
  // Public info reflects the change.
  assert.equal((await j('GET', `/api/trips/${trip.code}`)).data.trip.name, 'Goa 2026');
});

test('DELETE trip: owner only, removes rows and files', async () => {
  const { trip, owner } = await createTrip('Doomed');
  const guest = await join(trip.code, 'Guest');
  const up = await upload(trip.code, guest.token, JPEG);
  assert.equal(up.status, 201);
  const dir = tripDir(trip.code);
  assert.ok(fs.existsSync(dir) && fs.readdirSync(dir).length === 1);

  assert.equal((await j('DELETE', `/api/trips/${trip.code}`, { token: guest.token })).status, 403);
  assert.equal((await j('DELETE', `/api/trips/${trip.code}`, { token: owner.token })).status, 200);
  assert.equal((await j('GET', `/api/trips/${trip.code}`)).status, 404);
  assert.equal((await j('GET', `/api/trips/${trip.code}/me`, { token: guest.token })).status, 404);
  assert.ok(!fs.existsSync(dir), 'photo directory removed');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM members WHERE trip_id NOT IN (SELECT id FROM trips)').get().n, 0, 'no orphan members');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM photos WHERE trip_id NOT IN (SELECT id FROM trips)').get().n, 0, 'no orphan photos');
});

// ---------------------------------------------------------------- 2. member management
test('remove member: token stops working, photos kept unless deletePhotos=1', async () => {
  const { trip, owner } = await createTrip();
  const a = await join(trip.code, 'Alice');
  const b = await join(trip.code, 'Bob');
  assert.equal((await upload(trip.code, a.token, JPEG)).status, 201);
  assert.equal((await upload(trip.code, b.token, PNG)).status, 201);
  const membersBefore = (await j('GET', `/api/trips/${trip.code}/members`, { token: owner.token })).data.members;
  assert.equal(membersBefore.length, 3);

  // Only the owner, and never the owner themselves.
  assert.equal((await j('DELETE', `/api/trips/${trip.code}/members/${b.id}`, { token: a.token })).status, 403);
  assert.equal((await j('DELETE', `/api/trips/${trip.code}/members/${owner.id}`, { token: owner.token })).status, 400);
  assert.equal((await j('DELETE', `/api/trips/${trip.code}/members/not-a-uuid`, { token: owner.token })).status, 404);

  // Remove Alice, keep her photos.
  const r1 = await j('DELETE', `/api/trips/${trip.code}/members/${a.id}`, { token: owner.token });
  assert.equal(r1.status, 200);
  assert.equal(r1.data.removedPhotos, 0);
  const meA = await j('GET', `/api/trips/${trip.code}/me`, { token: a.token });
  assert.equal(meA.status, 401);
  assert.match(meA.data.error, /removed/i);
  assert.equal((await upload(trip.code, a.token, PNG)).status, 401, 'removed member cannot upload');
  let photos = (await j('GET', `/api/trips/${trip.code}/photos`, { token: owner.token })).data.photos;
  assert.equal(photos.length, 2, 'Alice photo still in the album');
  assert.equal(photos.find((p) => p.memberId === a.id).memberName, 'Alice');
  const info = (await j('GET', `/api/trips/${trip.code}`)).data.trip;
  assert.equal(info.memberCount, 2, 'removed members are not counted');
  assert.equal((await j('DELETE', `/api/trips/${trip.code}/members/${a.id}`, { token: owner.token })).status, 404, 'already removed');

  // Remove Bob and his photos.
  const bobFile = path.join(tripDir(trip.code), path.basename(new URL(photos.find((p) => p.memberId === b.id).url, 'http://x').pathname.replace(/\/file$/, '')) + '.png');
  assert.ok(fs.existsSync(bobFile));
  const r2 = await j('DELETE', `/api/trips/${trip.code}/members/${b.id}?deletePhotos=1`, { token: owner.token });
  assert.equal(r2.status, 200);
  assert.equal(r2.data.removedPhotos, 1);
  photos = (await j('GET', `/api/trips/${trip.code}/photos`, { token: owner.token })).data.photos;
  assert.equal(photos.length, 1);
  assert.ok(!fs.existsSync(bobFile), 'Bob file deleted from disk');
});

test('members can rename themselves', async () => {
  const { trip, owner } = await createTrip();
  const a = await join(trip.code, 'Alice');
  assert.equal((await j('PATCH', `/api/trips/${trip.code}/me`, { token: a.token, json: {} })).status, 400);
  const r = await j('PATCH', `/api/trips/${trip.code}/me`, { token: a.token, json: { name: '  Alice S  ' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.member.name, 'Alice S');
  const members = (await j('GET', `/api/trips/${trip.code}/members`, { token: owner.token })).data.members;
  assert.equal(members.find((m) => m.id === a.id).name, 'Alice S');
  // Empty name keeps the previous one.
  assert.equal((await j('PATCH', `/api/trips/${trip.code}/me`, { token: a.token, json: { name: '   ' } })).data.member.name, 'Alice S');
});

// ---------------------------------------------------------------- 3. link rotation
test('rotate code: old link answers 410, tokens keep working on the new code', async () => {
  const { trip, owner } = await createTrip('Rotating');
  const a = await join(trip.code, 'Alice');
  assert.equal((await j('POST', `/api/trips/${trip.code}/rotate`, { token: a.token })).status, 403);
  const r = await j('POST', `/api/trips/${trip.code}/rotate`, { token: owner.token });
  assert.equal(r.status, 200);
  const fresh = r.data.trip.code;
  assert.notEqual(fresh, trip.code);
  assert.equal(r.data.previousCode, trip.code);

  const old = await j('GET', `/api/trips/${trip.code}`);
  assert.equal(old.status, 410);
  assert.match(old.data.error, /expired.*organiser/i);
  assert.equal((await j('POST', `/api/trips/${trip.code}/join`, { json: { name: 'Late' } })).status, 410, 'cannot join via old code');
  assert.equal((await j('GET', `/api/trips/${fresh}/me`, { token: a.token })).status, 200, 'existing member still in');
  // A member holding a valid token can resolve the retired code to the current one; strangers cannot.
  const forwarded = await j('GET', `/api/trips/${trip.code}/me`, { token: a.token });
  assert.equal(forwarded.status, 200);
  assert.equal(forwarded.data.trip.code, fresh);
  assert.equal((await j('GET', `/api/trips/${trip.code}/me`, { token: 'stranger-token' })).status, 401);
  const otherTrip = await createTrip('Other');
  assert.equal((await j('GET', `/api/trips/${trip.code}/me`, { token: otherTrip.owner.token })).status, 401, 'member of a different trip cannot resolve it');
  assert.equal((await j('GET', `/api/trips/${fresh}`)).data.name, undefined);
  assert.equal((await j('GET', `/api/trips/${fresh}`)).data.trip.name, 'Rotating');
  // Photo URLs under the new code work; a second rotation retires the second code too.
  assert.equal((await upload(fresh, a.token, JPEG)).status, 201);
  const r2 = await j('POST', `/api/trips/${fresh}/rotate`, { token: owner.token });
  assert.equal((await j('GET', `/api/trips/${fresh}`)).status, 410);
  assert.equal((await j('GET', `/api/trips/${r2.data.trip.code}`)).status, 200);
});

// ---------------------------------------------------------------- 4. duplicates
test('identical bytes in the same trip -> 409 with the existing photo; other trips unaffected', async () => {
  const { trip, owner } = await createTrip();
  const a = await join(trip.code, 'Alice');
  const first = await upload(trip.code, a.token, JPEG);
  assert.equal(first.status, 201);
  const again = await upload(trip.code, owner.token, JPEG);
  assert.equal(again.status, 409);
  assert.equal(again.data.photo.id, first.data.photo.id);
  assert.match(again.data.error, /already/i);
  assert.equal((await j('GET', `/api/trips/${trip.code}/photos`, { token: a.token })).data.photos.length, 1);
  assert.equal(db.prepare('SELECT sha256 FROM photos WHERE id = ?').get(first.data.photo.id).sha256.length, 64);
  // Same bytes in another trip are a fresh photo.
  const other = await createTrip('Other');
  assert.equal((await upload(other.trip.code, other.owner.token, JPEG)).status, 201);
});

// ---------------------------------------------------------------- 5. retention
test('retention: 90 days from creation, extended by uploads and by the owner; sweep deletes expired trips', async () => {
  const t0 = Date.now();
  const { trip, owner } = await createTrip('Expiring');
  assert.ok(Math.abs(trip.expiresAt - (t0 + 90 * DAY)) < 5000, 'expires 90 days after creation');
  assert.equal(trip.retentionDays, 90);

  // Simulate an old trip whose last activity was 80 days ago, then upload: expiry moves to now + 90d.
  db.prepare('UPDATE trips SET expires_at = ? WHERE code = ?').run(t0 + 10 * DAY, trip.code);
  await upload(trip.code, owner.token, JPEG);
  let info = (await j('GET', `/api/trips/${trip.code}`)).data.trip;
  assert.ok(info.expiresAt >= t0 + 90 * DAY - 5000, 'upload extended expiry');
  assert.ok(Math.abs(info.lastActivityAt - Date.now()) < 5000);

  // Owner extends by 30 days; cannot exceed 365 days from today; guests cannot extend.
  const ext = await j('PATCH', `/api/trips/${trip.code}`, { token: owner.token, json: { extendDays: 30 } });
  assert.equal(ext.status, 200);
  assert.ok(Math.abs(ext.data.trip.expiresAt - (info.expiresAt + 30 * DAY)) < 5000);
  assert.equal((await j('PATCH', `/api/trips/${trip.code}`, { token: owner.token, json: { extendDays: 400 } })).status, 400);
  assert.equal((await j('PATCH', `/api/trips/${trip.code}`, { token: owner.token, json: { extendDays: 300 } })).status, 400, 'would exceed 365 days total');
  assert.equal((await j('PATCH', `/api/trips/${trip.code}`, { token: owner.token, json: { expiresAt: t0 - 1000 } })).status, 400, 'past timestamp');
  const guest = await join(trip.code, 'Guest');
  assert.equal((await j('PATCH', `/api/trips/${trip.code}`, { token: guest.token, json: { extendDays: 1 } })).status, 403);

  // Sweep: nothing expired yet, then force expiry and sweep again.
  assert.equal(await sweepExpired(), 0);
  const dir = tripDir(trip.code);
  db.prepare('UPDATE trips SET expires_at = ? WHERE code = ?').run(Date.now() - 1000, trip.code);
  const keep = await createTrip('Keep me');
  assert.equal(await sweepExpired(), 1);
  assert.equal((await j('GET', `/api/trips/${trip.code}`)).status, 404);
  assert.ok(!fs.existsSync(dir), 'swept trip files removed');
  assert.equal((await j('GET', `/api/trips/${keep.trip.code}`)).status, 200, 'unexpired trip untouched');
});

// ---------------------------------------------------------------- 6. health
test('health reports counts, disk and uptime', async () => {
  const r = await j('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  assert.equal(typeof r.data.uptimeSeconds, 'number');
  assert.ok(r.data.trips >= 1 && r.data.members >= 1 && r.data.photos >= 1);
  assert.ok(r.data.photoBytes > 0);
  assert.ok(r.data.disk === null || (r.data.disk.freeBytes > 0 && r.data.disk.totalBytes >= r.data.disk.freeBytes));
});
