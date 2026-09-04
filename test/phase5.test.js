'use strict';
/* Phase 5: join approval, PIN, co-organisers, reports, school preset, branding. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'triplink-p5-'));
process.env.PORT = '0';
process.env.LOG = 'off';
process.env.JOIN_ATTEMPTS_PER_MIN = '6';
const { server, DATA_DIR } = require('../server.js');

let base;
before(async () => { await new Promise((r) => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`; });
after(async () => { await new Promise((r) => server.close(r)); fs.rmSync(DATA_DIR, { recursive: true, force: true }); });

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
const createTrip = async (name = 'Trip') => { const r = await j('POST', '/api/trips', { json: { name, creatorName: 'Owner' } }); return { trip: r.data.trip, owner: r.data.member }; };
const join = (code, name, extra = {}) => j('POST', `/api/trips/${code}/join`, { json: { name, ...extra } });

test('defaults: open join, no PIN, comments on, owner role', async () => {
  const { trip, owner } = await createTrip();
  assert.equal(trip.joinMode, 'open'); assert.equal(trip.requiresPin, false); assert.equal(trip.commentsEnabled, true);
  assert.equal(owner.role, 'owner'); assert.equal(owner.isOrganiser, true);
  const me = (await j('GET', `/api/trips/${trip.code}/me`, { token: owner.token })).data.member;
  assert.equal(me.role, 'owner'); assert.equal(me.status, 'active');
});

test('approval mode: joiners wait, cannot act, organiser approves or rejects', async () => {
  const { trip, owner } = await createTrip('Approval');
  assert.equal((await j('PATCH', `/api/trips/${trip.code}`, { token: owner.token, json: { joinMode: 'sideways' } })).status, 400);
  assert.equal((await j('PATCH', `/api/trips/${trip.code}`, { token: owner.token, json: { joinMode: 'approval' } })).data.trip.joinMode, 'approval');
  const p = await join(trip.code, 'Priya');
  assert.equal(p.status, 201);
  assert.equal(p.data.member.status, 'pending');
  const me = await j('GET', `/api/trips/${trip.code}/me`, { token: p.data.member.token });
  assert.equal(me.status, 200, 'pending members can poll /me');
  assert.equal(me.data.member.status, 'pending');
  const blocked = await j('GET', `/api/trips/${trip.code}/photos`, { token: p.data.member.token });
  assert.equal(blocked.status, 403);
  assert.match(blocked.data.error, /waiting/i);
  assert.equal((await j('POST', `/api/trips/${trip.code}/photos`, { token: p.data.member.token, body: JPEG })).status, 403);
  assert.equal((await j('GET', `/api/trips/${trip.code}`)).data.trip.memberCount, 1, 'pending not counted');

  const list = await j('GET', `/api/trips/${trip.code}/members`, { token: owner.token });
  assert.deepEqual(list.data.pending.map((m) => m.name), ['Priya']);
  assert.equal(list.data.members.length, 1);
  const r2 = await join(trip.code, 'Rando');
  assert.equal((await j('POST', `/api/trips/${trip.code}/members/${p.data.member.id}/approve`, { token: r2.data.member.token })).status, 403, 'pending cannot approve');
  const ok = await j('POST', `/api/trips/${trip.code}/members/${p.data.member.id}/approve`, { token: owner.token });
  assert.equal(ok.status, 200); assert.equal(ok.data.member.status, 'active');
  assert.equal((await j('GET', `/api/trips/${trip.code}/photos`, { token: p.data.member.token })).status, 200);
  const rej = await j('POST', `/api/trips/${trip.code}/members/${r2.data.member.id}/reject`, { token: owner.token });
  assert.equal(rej.data.member.status, 'rejected');
  const gone = await j('GET', `/api/trips/${trip.code}/me`, { token: r2.data.member.token });
  assert.equal(gone.status, 401);
  assert.match(gone.data.error, /did not approve/);
  assert.equal((await j('POST', `/api/trips/${trip.code}/members/${r2.data.member.id}/approve`, { token: owner.token })).status, 404, 'nothing pending anymore');
  // Non-organiser members do not see the pending list.
  assert.equal((await j('GET', `/api/trips/${trip.code}/members`, { token: p.data.member.token })).data.pending, undefined);
});

test('PIN mode: 4–8 digits, wrong PIN 401, join attempts rate-limited, PIN can be cleared', async () => {
  const { trip, owner } = await createTrip('PIN');
  assert.equal((await j('PATCH', `/api/trips/${trip.code}`, { token: owner.token, json: { pin: 'abcd' } })).status, 400);
  assert.equal((await j('PATCH', `/api/trips/${trip.code}`, { token: owner.token, json: { pin: '123' } })).status, 400);
  const set = await j('PATCH', `/api/trips/${trip.code}`, { token: owner.token, json: { pin: '2468' } });
  assert.equal(set.data.trip.requiresPin, true);
  assert.equal((await j('GET', `/api/trips/${trip.code}`)).data.trip.requiresPin, true, 'public info says a PIN is needed (never the PIN)');
  const noPin = await join(trip.code, 'A');
  assert.equal(noPin.status, 401); assert.match(noPin.data.error, /needs a PIN/);
  const wrong = await join(trip.code, 'A', { pin: '0000' });
  assert.equal(wrong.status, 401); assert.match(wrong.data.error, /Wrong PIN/);
  const right = await join(trip.code, 'A', { pin: '2468' });
  assert.equal(right.status, 201); assert.equal(right.data.member.status, 'active');
  // 6 attempts per minute in this test process; we have used 3.
  for (let i = 0; i < 3; i++) await join(trip.code, 'B', { pin: '1111' });
  const limited = await join(trip.code, 'B', { pin: '2468' });
  assert.equal(limited.status, 429);
  assert.equal((await j('PATCH', `/api/trips/${trip.code}`, { token: owner.token, json: { pin: null } })).data.trip.requiresPin, false);
});

test('co-organisers: owner promotes, organisers manage, only owner deletes trip / changes roles / removes organisers', async () => {
  const { trip, owner } = await createTrip('Co');
  const priya = (await join(trip.code, 'Priya')).data.member;
  const arjun = (await join(trip.code, 'Arjun')).data.member;
  assert.equal((await j('PATCH', `/api/trips/${trip.code}`, { token: priya.token, json: { name: 'x' } })).status, 403);
  assert.equal((await j('POST', `/api/trips/${trip.code}/members/${priya.id}/role`, { token: arjun.token, json: { role: 'organiser' } })).status, 403);
  assert.equal((await j('POST', `/api/trips/${trip.code}/members/${owner.id}/role`, { token: owner.token, json: { role: 'member' } })).status, 400, 'owner role fixed');
  assert.equal((await j('POST', `/api/trips/${trip.code}/members/${priya.id}/role`, { token: owner.token, json: { role: 'king' } })).status, 400);
  const promoted = await j('POST', `/api/trips/${trip.code}/members/${priya.id}/role`, { token: owner.token, json: { role: 'organiser' } });
  assert.equal(promoted.data.member.role, 'organiser'); assert.equal(promoted.data.member.isOrganiser, true); assert.equal(promoted.data.member.isOwner, false);
  // Organiser powers
  assert.equal((await j('PATCH', `/api/trips/${trip.code}`, { token: priya.token, json: { name: 'Renamed by Priya' } })).status, 200);
  const photo = (await j('POST', `/api/trips/${trip.code}/photos`, { token: arjun.token, body: JPEG })).data.photo;
  assert.equal((await j('DELETE', `/api/trips/${trip.code}/photos/${photo.id}`, { token: priya.token })).status, 200, 'organiser deletes others photos');
  assert.equal((await j('DELETE', `/api/trips/${trip.code}/members/${arjun.id}`, { token: priya.token })).status, 200, 'organiser removes a member');
  // Owner-only
  assert.equal((await j('DELETE', `/api/trips/${trip.code}`, { token: priya.token })).status, 403);
  assert.equal((await j('DELETE', `/api/trips/${trip.code}/members/${owner.id}`, { token: priya.token })).status, 400, 'owner cannot be removed');
  const kiran = (await join(trip.code, 'Kiran')).data.member;
  await j('POST', `/api/trips/${trip.code}/members/${kiran.id}/role`, { token: owner.token, json: { role: 'organiser' } });
  assert.equal((await j('DELETE', `/api/trips/${trip.code}/members/${kiran.id}`, { token: priya.token })).status, 403, 'organiser cannot remove another organiser');
  assert.equal((await j('DELETE', `/api/trips/${trip.code}/members/${kiran.id}`, { token: owner.token })).status, 200);
  const members = (await j('GET', `/api/trips/${trip.code}/members`, { token: priya.token })).data.members;
  assert.deepEqual(members.map((m) => [m.name, m.role]), [['Owner', 'owner'], ['Priya', 'organiser']]);
  assert.equal((await j('POST', `/api/trips/${trip.code}/members/${priya.id}/role`, { token: owner.token, json: { role: 'member' } })).data.member.role, 'member');
  assert.equal((await j('PATCH', `/api/trips/${trip.code}`, { token: priya.token, json: { name: 'x' } })).status, 403, 'demoted');
});

test('reports: hidden for the reporter, counted for organisers, dismissable', async () => {
  const { trip, owner } = await createTrip('Reports');
  const priya = (await join(trip.code, 'Priya')).data.member;
  const photo = (await j('POST', `/api/trips/${trip.code}/photos`, { token: owner.token, body: JPEG })).data.photo;
  const r = await j('POST', `/api/trips/${trip.code}/photos/${photo.id}/report`, { token: priya.token, json: { reason: 'Not mine to share' } });
  assert.deepEqual(r.data, { reported: true, reportCount: 1 });
  const mine = (await j('GET', `/api/trips/${trip.code}/photos`, { token: priya.token })).data.photos[0];
  assert.equal(mine.reportedByMe, true);
  const theirs = (await j('GET', `/api/trips/${trip.code}/photos`, { token: owner.token })).data.photos[0];
  assert.equal(theirs.reportedByMe, false); assert.equal(theirs.reportCount, 1);
  assert.equal((await j('DELETE', `/api/trips/${trip.code}/photos/${photo.id}/reports`, { token: priya.token })).status, 403);
  assert.equal((await j('DELETE', `/api/trips/${trip.code}/photos/${photo.id}/reports`, { token: owner.token })).status, 200);
  assert.equal((await j('GET', `/api/trips/${trip.code}/photos`, { token: owner.token })).data.photos[0].reportCount, 0);
});

test('school preset: approval on, comments off, 30-day retention; can be turned off again', async () => {
  const { trip, owner } = await createTrip('Class 7B');
  const before = trip.expiresAt;
  const r = await j('PATCH', `/api/trips/${trip.code}`, { token: owner.token, json: { preset: 'school' } });
  assert.equal(r.status, 200);
  const t = r.data.trip;
  assert.equal(t.preset, 'school'); assert.equal(t.joinMode, 'approval'); assert.equal(t.commentsEnabled, false); assert.equal(t.retentionDays, 30);
  assert.ok(t.expiresAt < before && Math.abs(t.expiresAt - (Date.now() + 30 * 86400000)) < 5000, 'expiry pulled in to 30 days');
  const photo = (await j('POST', `/api/trips/${trip.code}/photos`, { token: owner.token, body: PNG })).data.photo;
  const c = await j('POST', `/api/trips/${trip.code}/photos/${photo.id}/comments`, { token: owner.token, json: { text: 'hi' } });
  assert.equal(c.status, 403);
  assert.equal((await join(trip.code, 'Kid')).data.member.status, 'pending');
  assert.equal((await j('PATCH', `/api/trips/${trip.code}`, { token: owner.token, json: { preset: 'gym' } })).status, 400);
  const off = (await j('PATCH', `/api/trips/${trip.code}`, { token: owner.token, json: { preset: null, joinMode: 'open', commentsEnabled: true } })).data.trip;
  assert.equal(off.preset, null); assert.equal(off.joinMode, 'open'); assert.equal(off.commentsEnabled, true);
});

test('branding: colour validated, logo uploaded/served/replaced, exposed publicly', async () => {
  const { trip, owner } = await createTrip('Brand');
  assert.equal((await j('PATCH', `/api/trips/${trip.code}`, { token: owner.token, json: { brandColor: 'red' } })).status, 400);
  const c = await j('PATCH', `/api/trips/${trip.code}`, { token: owner.token, json: { brandColor: '#1E90FF' } });
  assert.equal(c.data.trip.brand.color, '#1E90FF'); assert.equal(c.data.trip.brand.logoUrl, null);
  assert.equal((await j('POST', `/api/trips/${trip.code}/brand-logo`, { token: owner.token, body: Buffer.from('<svg/>') })).status, 415);
  const up = await j('POST', `/api/trips/${trip.code}/brand-logo`, { token: owner.token, body: PNG });
  assert.equal(up.status, 200);
  assert.match(up.data.trip.brand.logoUrl, /\/brand-logo\?v=png$/);
  const pub = (await j('GET', `/api/trips/${trip.code}`)).data.trip;
  assert.equal(pub.brand.color, '#1E90FF');
  const logo = await fetch(base + pub.brand.logoUrl);
  assert.equal(logo.status, 200); assert.equal(logo.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.compare(Buffer.from(await logo.arrayBuffer()), PNG), 0);
  const up2 = await j('POST', `/api/trips/${trip.code}/brand-logo`, { token: owner.token, body: JPEG });
  assert.match(up2.data.trip.brand.logoUrl, /v=jpg$/);
  assert.equal((await fetch(base + up2.data.trip.brand.logoUrl)).headers.get('content-type'), 'image/jpeg');
  const guest = (await join(trip.code, 'G')).data.member;
  assert.equal((await j('POST', `/api/trips/${trip.code}/brand-logo`, { token: guest.token, body: PNG })).status, 403);
});
