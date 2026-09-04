'use strict';
/* Phase 4: favourites/hearts, comments, favourites-only zip, listing counts. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'triplink-p4-'));
process.env.PORT = '0';
process.env.LOG = 'off';
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

let trip, owner, priya, a, b;
test('setup', async () => {
  const r = await j('POST', '/api/trips', { json: { name: 'Goa', creatorName: 'Srujan' } });
  trip = r.data.trip; owner = r.data.member;
  priya = (await j('POST', `/api/trips/${trip.code}/join`, { json: { name: 'Priya' } })).data.member;
  a = (await j('POST', `/api/trips/${trip.code}/photos`, { body: JPEG, token: owner.token })).data.photo;
  b = (await j('POST', `/api/trips/${trip.code}/photos`, { body: PNG, token: priya.token })).data.photo;
});

test('hearts: one per member, counts visible to everyone, favourited is per viewer', async () => {
  const fav = (token, id, on) => j(on ? 'POST' : 'DELETE', `/api/trips/${trip.code}/photos/${id}/favourite`, { token });
  assert.equal((await fav('nope', a.id, true)).status, 401);
  let r = await fav(priya.token, a.id, true);
  assert.deepEqual(r.data, { favourited: true, hearts: 1 });
  r = await fav(priya.token, a.id, true);
  assert.deepEqual(r.data, { favourited: true, hearts: 1 }, 'idempotent');
  r = await fav(owner.token, a.id, true);
  assert.equal(r.data.hearts, 2);
  const forPriya = (await j('GET', `/api/trips/${trip.code}/photos`, { token: priya.token })).data.photos;
  const forOwner = (await j('GET', `/api/trips/${trip.code}/photos`, { token: owner.token })).data.photos;
  const pa = forPriya.find((p) => p.id === a.id), oa = forOwner.find((p) => p.id === a.id), pb = forPriya.find((p) => p.id === b.id);
  assert.equal(pa.hearts, 2); assert.equal(pa.favourited, true);
  assert.equal(oa.hearts, 2); assert.equal(oa.favourited, true);
  assert.equal(pb.hearts, 0); assert.equal(pb.favourited, false);
  r = await fav(priya.token, a.id, false);
  assert.deepEqual(r.data, { favourited: false, hearts: 1 });
  assert.equal((await fav(priya.token, '00000000-0000-0000-0000-000000000000', true)).status, 404);
});

test('favourites zip contains only the viewer\'s favourites', async () => {
  await j('POST', `/api/trips/${trip.code}/photos/${b.id}/favourite`, { token: priya.token });
  const none = await fetch(`${base}/api/trips/${trip.code}/download.zip?favourites=1`, { headers: { 'X-Member-Token': (await j('POST', `/api/trips/${trip.code}/join`, { json: { name: 'Nobody' } })).data.member.token } });
  assert.equal(none.status, 404);
  const r = await fetch(`${base}/api/trips/${trip.code}/download.zip?favourites=1`, { headers: { 'X-Member-Token': priya.token } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /Goa_favourites\.zip/);
  const buf = Buffer.from(await r.arrayBuffer());
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.equal(buf.readUInt16LE(eocd + 10), 1, 'one entry: Priya hearts only b');
  const all = await fetch(`${base}/api/trips/${trip.code}/download.zip`, { headers: { 'X-Member-Token': priya.token } });
  const bufAll = Buffer.from(await all.arrayBuffer());
  assert.equal(bufAll.readUInt16LE(bufAll.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])) + 10), 2);
});

test('comments: 280 chars, listed in order, deletable by author or organiser, counted in the listing', async () => {
  const url = `/api/trips/${trip.code}/photos/${a.id}/comments`;
  assert.equal((await j('POST', url, { token: priya.token, json: { text: '   ' } })).status, 400);
  assert.equal((await j('POST', url, { token: priya.token, json: { text: 'x'.repeat(281) } })).status, 400);
  assert.equal((await j('POST', url, { token: priya.token, json: { text: '😀'.repeat(280) } })).status, 201, 'counts characters, not bytes');
  const c1 = await j('POST', url, { token: priya.token, json: { text: ' Best sunset of the trip! ' } });
  assert.equal(c1.status, 201);
  assert.equal(c1.data.comment.text, 'Best sunset of the trip!', 'trimmed, control chars stripped');
  assert.equal(c1.data.comment.memberName, 'Priya');
  const c2 = await j('POST', url, { token: owner.token, json: { text: 'Agreed' } });
  const list = (await j('GET', url, { token: priya.token })).data.comments;
  assert.equal(list.length, 3);
  assert.deepEqual(list.slice(1).map((c) => c.text), ['Best sunset of the trip!', 'Agreed']);
  const photos = (await j('GET', `/api/trips/${trip.code}/photos`, { token: owner.token })).data.photos;
  assert.equal(photos.find((p) => p.id === a.id).commentCount, 3);
  assert.equal(photos.find((p) => p.id === b.id).commentCount, 0);
  // Permissions
  assert.equal((await j('DELETE', `${url}/${c2.data.comment.id}`, { token: priya.token })).status, 403, 'not the author');
  assert.equal((await j('DELETE', `${url}/${c1.data.comment.id}`, { token: owner.token })).status, 200, 'organiser may delete any');
  assert.equal((await j('DELETE', `${url}/${c2.data.comment.id}`, { token: owner.token })).status, 200, 'author may delete own');
  assert.equal((await j('GET', url, { token: priya.token })).data.comments.length, 1);
  assert.equal((await j('GET', url)).status, 401);
  // Deleting the photo removes its comments and hearts.
  await j('DELETE', `/api/trips/${trip.code}/photos/${a.id}`, { token: owner.token });
  assert.equal((await j('GET', url, { token: priya.token })).status, 404);
});
