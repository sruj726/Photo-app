#!/usr/bin/env node
/**
 * TripLink server – zero-dependency Node.js backend for the trip photo-sharing app.
 *
 * Runs on Node >= 22.13 (uses the built-in node:sqlite module).
 *   node server.js            -> http://localhost:8787
 *   PORT=3000 DATA_DIR=/srv/triplink node server.js
 *
 * Responsibilities
 *   - serve the PWA shell in ./public
 *   - JSON API for trips / members / photos
 *   - store originals + thumbnails on disk, metadata in SQLite
 *   - stream a ZIP of every photo in a trip ("Download all")
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const webpush = require('./push.js');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PHOTO_DIR = path.join(DATA_DIR, 'photos');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_PHOTO_BYTES = 25 * 1024 * 1024; // 25 MB per original
const MAX_THUMB_BYTES = 1 * 1024 * 1024;
const MAX_JSON_BYTES = 64 * 1024;
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN || 240);
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS || 90);   // trips expire this long after the last upload
const MAX_RETENTION_DAYS = 365;
const LOG_REQUESTS = process.env.LOG !== 'off';
const DAY_MS = 86400000;
const STARTED_AT = Date.now();
const PUSH_SUBJECT = process.env.PUSH_SUBJECT || 'mailto:admin@example.com';   // VAPID contact, change in production
const PUSH_BATCH_MS = Number(process.env.PUSH_BATCH_MS || 30 * 60 * 1000);       // "N new photos" at most once per trip per window
const RECAP_AFTER_MS = Number(process.env.RECAP_AFTER_MS || 48 * 3600 * 1000);   // end-of-trip recap this long after the last upload
const BASE_URL = (process.env.TRIPLINK_BASE_URL || '').replace(/\/+$/, '');      // public URL used in share links, e.g. https://photos.example.com

fs.mkdirSync(PHOTO_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------
const db = new DatabaseSync(path.join(DATA_DIR, 'triplink.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS trips (
    id TEXT PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    owner_member_id TEXT,
    created_at INTEGER NOT NULL,
    start_date TEXT,
    end_date TEXT,
    expires_at INTEGER,
    last_activity_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS members (
    id TEXT PRIMARY KEY,
    trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token TEXT UNIQUE NOT NULL,
    joined_at INTEGER NOT NULL,
    removed_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS members_trip ON members(trip_id);
  CREATE TABLE IF NOT EXISTS photos (
    id TEXT PRIMARY KEY,
    trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    mime TEXT NOT NULL,
    ext TEXT NOT NULL,
    size INTEGER NOT NULL,
    width INTEGER,
    height INTEGER,
    taken_at INTEGER,
    created_at INTEGER NOT NULL,
    has_thumb INTEGER NOT NULL DEFAULT 0,
    sha256 TEXT
  );
  CREATE INDEX IF NOT EXISTS photos_trip ON photos(trip_id, created_at);
  CREATE TABLE IF NOT EXISTS retired_codes (
    code TEXT PRIMARY KEY,
    trip_id TEXT NOT NULL,
    retired_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id TEXT PRIMARY KEY,
    trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (trip_id, endpoint)
  );
`);

// Additive migrations for databases created by older versions.
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
ensureColumn('trips', 'start_date', 'TEXT');
ensureColumn('trips', 'end_date', 'TEXT');
ensureColumn('trips', 'expires_at', 'INTEGER');
ensureColumn('trips', 'last_activity_at', 'INTEGER');
ensureColumn('trips', 'recap_sent_at', 'INTEGER');
ensureColumn('members', 'removed_at', 'INTEGER');
ensureColumn('photos', 'sha256', 'TEXT');
db.exec('CREATE INDEX IF NOT EXISTS photos_hash ON photos(trip_id, sha256)');

const vapidKeys = webpush.loadOrCreateKeys(path.join(DATA_DIR, 'vapid.json'));

const q = {
  insertTrip: db.prepare('INSERT INTO trips (id, code, name, owner_member_id, created_at, expires_at, last_activity_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  setOwner: db.prepare('UPDATE trips SET owner_member_id = ? WHERE id = ?'),
  tripByCode: db.prepare('SELECT * FROM trips WHERE code = ?'),
  tripById: db.prepare('SELECT * FROM trips WHERE id = ?'),
  updateTrip: db.prepare('UPDATE trips SET name = ?, start_date = ?, end_date = ?, expires_at = ? WHERE id = ?'),
  touchTrip: db.prepare('UPDATE trips SET last_activity_at = ?, expires_at = MAX(COALESCE(expires_at, 0), ?) WHERE id = ?'),
  setTripCode: db.prepare('UPDATE trips SET code = ? WHERE id = ?'),
  deleteTrip: db.prepare('DELETE FROM trips WHERE id = ?'),
  expiredTrips: db.prepare('SELECT * FROM trips WHERE expires_at IS NOT NULL AND expires_at < ?'),
  insertRetired: db.prepare('INSERT OR REPLACE INTO retired_codes (code, trip_id, retired_at) VALUES (?, ?, ?)'),
  retiredByCode: db.prepare('SELECT * FROM retired_codes WHERE code = ?'),
  deleteRetiredOfTrip: db.prepare('DELETE FROM retired_codes WHERE trip_id = ?'),
  tripStats: db.prepare(`SELECT
      (SELECT COUNT(*) FROM members WHERE trip_id = ? AND removed_at IS NULL) AS member_count,
      (SELECT COUNT(*) FROM photos  WHERE trip_id = ?) AS photo_count,
      (SELECT COALESCE(SUM(size),0) FROM photos WHERE trip_id = ?) AS total_bytes`),
  globalStats: db.prepare(`SELECT
      (SELECT COUNT(*) FROM trips) AS trips,
      (SELECT COUNT(*) FROM members WHERE removed_at IS NULL) AS members,
      (SELECT COUNT(*) FROM photos) AS photos,
      (SELECT COALESCE(SUM(size),0) FROM photos) AS photo_bytes`),
  insertMember: db.prepare('INSERT INTO members (id, trip_id, name, token, joined_at) VALUES (?, ?, ?, ?, ?)'),
  memberByToken: db.prepare('SELECT * FROM members WHERE token = ?'),
  memberById: db.prepare('SELECT * FROM members WHERE id = ? AND trip_id = ?'),
  renameMember: db.prepare('UPDATE members SET name = ? WHERE id = ?'),
  removeMember: db.prepare('UPDATE members SET removed_at = ? WHERE id = ?'),
  photosOfMember: db.prepare('SELECT * FROM photos WHERE member_id = ?'),
  deletePhotosOfMember: db.prepare('DELETE FROM photos WHERE member_id = ?'),
  membersOfTrip: db.prepare(`SELECT m.id, m.name, m.joined_at,
        (SELECT COUNT(*) FROM photos p WHERE p.member_id = m.id) AS photo_count
      FROM members m WHERE m.trip_id = ? AND m.removed_at IS NULL ORDER BY m.joined_at`),
  insertPhoto: db.prepare(`INSERT INTO photos (id, trip_id, member_id, mime, ext, size, width, height, taken_at, created_at, has_thumb, sha256)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`),
  photoByHash: db.prepare(`SELECT p.*, m.name AS member_name FROM photos p JOIN members m ON m.id = p.member_id
      WHERE p.trip_id = ? AND p.sha256 = ?`),
  setThumb: db.prepare('UPDATE photos SET has_thumb = 1 WHERE id = ?'),
  photoById: db.prepare(`SELECT p.*, m.name AS member_name FROM photos p JOIN members m ON m.id = p.member_id
      WHERE p.id = ? AND p.trip_id = ?`),
  photosOfTrip: db.prepare(`SELECT p.id, p.mime, p.size, p.width, p.height, p.taken_at, p.created_at, p.has_thumb,
        p.member_id, m.name AS member_name
      FROM photos p JOIN members m ON m.id = p.member_id
      WHERE p.trip_id = ? ORDER BY COALESCE(p.taken_at, p.created_at) DESC, p.created_at DESC`),
  photosOfTripAsc: db.prepare(`SELECT p.*, m.name AS member_name FROM photos p JOIN members m ON m.id = p.member_id
      WHERE p.trip_id = ? ORDER BY COALESCE(p.taken_at, p.created_at) ASC`),
  deletePhoto: db.prepare('DELETE FROM photos WHERE id = ?'),
  upsertPushSub: db.prepare(`INSERT INTO push_subscriptions (id, trip_id, member_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (trip_id, endpoint) DO UPDATE SET member_id = excluded.member_id, p256dh = excluded.p256dh, auth = excluded.auth`),
  deletePushSub: db.prepare('DELETE FROM push_subscriptions WHERE trip_id = ? AND endpoint = ?'),
  deletePushSubById: db.prepare('DELETE FROM push_subscriptions WHERE id = ?'),
  pushSubsOfTrip: db.prepare('SELECT * FROM push_subscriptions WHERE trip_id = ?'),
  pushSubOfMember: db.prepare('SELECT id FROM push_subscriptions WHERE trip_id = ? AND member_id = ? LIMIT 1'),
  tripsNeedingRecap: db.prepare(`SELECT t.* FROM trips t WHERE t.recap_sent_at IS NULL AND t.last_activity_at IS NOT NULL AND t.last_activity_at < ?
      AND EXISTS (SELECT 1 FROM photos p WHERE p.trip_id = t.id) AND EXISTS (SELECT 1 FROM push_subscriptions s WHERE s.trip_id = t.id)`),
  setRecapSent: db.prepare('UPDATE trips SET recap_sent_at = ? WHERE id = ?'),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no 0/o/1/l/i ambiguity
function randomCode(len = 10) {
  const bytes = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return s;
}
const newId = () => crypto.randomUUID();
const newToken = () => crypto.randomBytes(24).toString('base64url');
const now = () => Date.now();
const ID_RE = /^[0-9a-f-]{36}$/;
const CODE_RE = /^[a-z0-9]{6,16}$/;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function sendJson(res, status, body, extraHeaders = {}) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(data);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > limit) {
        reject(new HttpError(413, `Body exceeds ${limit} bytes`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req, MAX_JSON_BYTES);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); }
  catch { throw new HttpError(400, 'Invalid JSON body'); }
}

function cleanName(raw, fallback) {
  const s = String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60);
  return s || fallback;
}

/** Sniff the real image type from magic bytes – never trust the header alone. */
function sniffImage(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { mime: 'image/png', ext: 'png' };
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  const ftyp = buf.toString('ascii', 4, 8);
  if (ftyp === 'ftyp') {
    const brand = buf.toString('ascii', 8, 12);
    if (/^(heic|heix|hevc|mif1|msf1)$/.test(brand)) return { mime: 'image/heic', ext: 'heic' };
  }
  return null;
}

function requireTrip(code) {
  if (!CODE_RE.test(code)) throw new HttpError(404, 'Trip not found');
  const trip = q.tripByCode.get(code);
  if (!trip) {
    if (q.retiredByCode.get(code)) throw new HttpError(410, 'This link has expired, ask the organiser for the new one');
    throw new HttpError(404, 'Trip not found');
  }
  return trip;
}

function requireMember(req, trip) {
  const token = req.headers['x-member-token'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token || typeof token !== 'string' || token.length > 128) throw new HttpError(401, 'Join the trip first');
  const member = q.memberByToken.get(token);
  if (!member || member.trip_id !== trip.id) throw new HttpError(401, 'Join the trip first');
  if (member.removed_at) throw new HttpError(401, 'You were removed from this trip by the organiser');
  return member;
}

function requireOwner(req, trip) {
  const member = requireMember(req, trip);
  if (member.id !== trip.owner_member_id) throw new HttpError(403, 'Only the trip organiser can do that');
  return member;
}

function photoPath(photo, thumb = false) {
  return path.join(PHOTO_DIR, photo.trip_id, thumb ? `${photo.id}.thumb.jpg` : `${photo.id}.${photo.ext}`);
}

function publicTrip(trip) {
  const stats = q.tripStats.get(trip.id, trip.id, trip.id);
  return {
    code: trip.code,
    name: trip.name,
    createdAt: trip.created_at,
    startDate: trip.start_date || null,
    endDate: trip.end_date || null,
    expiresAt: trip.expires_at || null,
    lastActivityAt: trip.last_activity_at || null,
    retentionDays: RETENTION_DAYS,
    baseUrl: BASE_URL || null,
    memberCount: stats.member_count,
    photoCount: stats.photo_count,
    totalBytes: stats.total_bytes,
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function cleanDate(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const s = String(raw);
  if (!DATE_RE.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) throw new HttpError(400, 'Dates must be YYYY-MM-DD');
  return s;
}

async function removeTripFiles(tripId) {
  await fsp.rm(path.join(PHOTO_DIR, tripId), { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Push notifications: batched "new photos" per trip, and an end-of-trip recap
// ---------------------------------------------------------------------------
const pushPending = new Map();   // trip_id -> { timer, count, names:Set, uploaders:Set }
const pushLog = [];              // last deliveries (for /api/health and tests)

async function deliverToTrip(trip, payload, { excludeMemberIds = new Set() } = {}) {
  const subs = q.pushSubsOfTrip.all(trip.id).filter((s) => !excludeMemberIds.has(s.member_id));
  let sent = 0, dropped = 0;
  for (const s of subs) {
    try {
      const r = await webpush.send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, vapidKeys, { subject: PUSH_SUBJECT, ttl: 24 * 3600 });
      if (r.status === 404 || r.status === 410) { q.deletePushSubById.run(s.id); dropped++; }
      else if (r.status >= 200 && r.status < 300) sent++;
      else console.error(`push to ${s.endpoint.slice(0, 40)}… answered ${r.status}`);
    } catch (err) { console.error('push failed:', err.message); }
  }
  pushLog.push({ at: now(), trip: trip.id, title: payload.title, sent, dropped });
  if (pushLog.length > 50) pushLog.shift();
  return { sent, dropped };
}

function queuePhotoPush(trip, member) {
  let p = pushPending.get(trip.id);
  if (!p) {
    p = { count: 0, names: new Set(), uploaders: new Set(), timer: null };
    p.timer = setTimeout(() => flushPhotoPush(trip.id), PUSH_BATCH_MS);
    p.timer.unref();
    pushPending.set(trip.id, p);
  }
  p.count += 1;
  p.names.add(member.name);
  p.uploaders.add(member.id);
}

async function flushPhotoPush(tripId) {
  const p = pushPending.get(tripId);
  if (!p) return null;
  pushPending.delete(tripId);
  clearTimeout(p.timer);
  const trip = q.tripById.get(tripId);
  if (!trip) return null;
  const names = [...p.names];
  const who = names.length <= 2 ? names.join(' and ') : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
  return deliverToTrip(trip, {
    title: trip.name,
    body: `${p.count} new photo${p.count === 1 ? '' : 's'} from ${who}`,
    url: `/t/${trip.code}?tab=photos`,
    tag: `photos-${trip.id}`,
  }, { excludeMemberIds: p.uploaders });
}

async function flushAllPhotoPush() {
  const ids = [...pushPending.keys()];
  const results = [];
  for (const id of ids) results.push(await flushPhotoPush(id));
  return results;
}

/** End-of-trip recap: sent once, RECAP_AFTER_MS after the last upload. Returns trips notified. */
async function sendRecaps(at = now()) {
  const due = q.tripsNeedingRecap.all(at - RECAP_AFTER_MS);
  const done = [];
  for (const trip of due) {
    const stats = q.tripStats.get(trip.id, trip.id, trip.id);
    await deliverToTrip(trip, {
      title: `${trip.name}: all the photos are in`,
      body: `${stats.photo_count} photo${stats.photo_count === 1 ? '' : 's'} from ${stats.member_count} ${stats.member_count === 1 ? 'person' : 'people'}. Get them all before ${new Date(trip.expires_at || at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}.`,
      url: `/t/${trip.code}?tab=photos`,
      tag: `recap-${trip.id}`,
    });
    q.setRecapSent.run(at, trip.id);
    done.push(trip.code);
  }
  return done;
}

/** Delete every trip whose retention window has passed. Returns the number removed. */
async function sweepExpired(at = now()) {
  const expired = q.expiredTrips.all(at);
  for (const trip of expired) {
    q.deleteTrip.run(trip.id);            // cascades to members + photos
    q.deleteRetiredOfTrip.run(trip.id);
    await removeTripFiles(trip.id);
  }
  return expired.length;
}

function publicPhoto(p, tripCode) {
  return {
    id: p.id,
    mime: p.mime,
    size: p.size,
    width: p.width,
    height: p.height,
    takenAt: p.taken_at,
    createdAt: p.created_at,
    memberId: p.member_id,
    memberName: p.member_name,
    url: `/api/trips/${tripCode}/photos/${p.id}/file`,
    thumbUrl: p.has_thumb ? `/api/trips/${tripCode}/photos/${p.id}/thumb` : `/api/trips/${tripCode}/photos/${p.id}/file`,
  };
}

// ---------------------------------------------------------------------------
// Minimal streaming ZIP writer (STORE method). Photos are already compressed,
// so deflating them again would only burn CPU for ~0% gain.
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function dosDateTime(ms) {
  const d = new Date(ms);
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}
async function streamZip(res, entries) {
  // entries: [{ name, filePath, mtime }]
  let offset = 0;
  const central = [];
  const write = (buf) => new Promise((resolve) => {
    offset += buf.length;
    if (!res.write(buf)) res.once('drain', resolve); else resolve();
  });
  for (const e of entries) {
    let data;
    try { data = await fsp.readFile(e.filePath); } catch { continue; }
    const name = Buffer.from(e.name, 'utf8');
    const crc = crc32(data);
    const { time, date } = dosDateTime(e.mtime);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);        // version needed
    local.writeUInt16LE(0x0800, 6);    // flags: UTF-8 names
    local.writeUInt16LE(0, 8);         // method: store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const headerOffset = offset;
    await write(local); await write(name); await write(data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8); cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(time, 12); cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28); cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36); cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(headerOffset, 42);
    central.push(Buffer.concat([cd, name]));
  }
  const cdStart = offset;
  for (const c of central) await write(c);
  const cdSize = offset - cdStart;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(central.length, 8); eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(cdSize, 12); eocd.writeUInt32LE(cdStart, 16); eocd.writeUInt16LE(0, 20);
  await write(eocd);
  res.end();
}

// ---------------------------------------------------------------------------
// Rate limiting (in-memory, per IP, per minute)
// ---------------------------------------------------------------------------
const buckets = new Map();
function rateLimited(ip) {
  const minute = Math.floor(now() / 60000);
  let b = buckets.get(ip);
  if (!b || b.minute !== minute) { b = { minute, n: 0 }; buckets.set(ip, b); }
  b.n += 1;
  if (buckets.size > 10000) buckets.clear();
  return b.n > RATE_LIMIT_PER_MIN;
}

// ---------------------------------------------------------------------------
// API handlers
// ---------------------------------------------------------------------------
async function apiCreateTrip(req, res) {
  const body = await readJson(req);
  const name = cleanName(body.name, 'Untitled trip');
  const creatorName = cleanName(body.creatorName, 'Trip creator');
  const tripId = newId();
  let code = randomCode();
  while (q.tripByCode.get(code)) code = randomCode();
  const memberId = newId();
  const token = newToken();
  const ts = now();
  q.insertTrip.run(tripId, code, name, null, ts, ts + RETENTION_DAYS * DAY_MS, ts);
  q.insertMember.run(memberId, tripId, creatorName, token, ts);
  q.setOwner.run(memberId, tripId);
  fs.mkdirSync(path.join(PHOTO_DIR, tripId), { recursive: true });
  const trip = q.tripByCode.get(code);
  sendJson(res, 201, { trip: publicTrip(trip), member: { id: memberId, name: creatorName, token, isOwner: true } });
}

function apiGetTrip(req, res, code) {
  const trip = requireTrip(code);
  sendJson(res, 200, { trip: publicTrip(trip) });
}

/** PATCH /api/trips/:code – rename, set dates, extend retention (owner only). */
async function apiUpdateTrip(req, res, code) {
  const trip = requireTrip(code);
  requireOwner(req, trip);
  const body = await readJson(req);
  const name = body.name !== undefined ? cleanName(body.name, trip.name) : trip.name;
  const startDate = body.startDate !== undefined ? cleanDate(body.startDate) : trip.start_date;
  const endDate = body.endDate !== undefined ? cleanDate(body.endDate) : trip.end_date;
  if (startDate && endDate && endDate < startDate) throw new HttpError(400, 'End date is before start date');
  let expiresAt = trip.expires_at;
  if (body.extendDays !== undefined) {
    const days = Number(body.extendDays);
    if (!Number.isInteger(days) || days < 1 || days > MAX_RETENTION_DAYS) throw new HttpError(400, `extendDays must be 1–${MAX_RETENTION_DAYS}`);
    expiresAt = Math.max(now(), expiresAt || 0) + days * DAY_MS;
  } else if (body.expiresAt !== undefined) {
    const t = Number(body.expiresAt);
    if (!Number.isFinite(t) || t < now()) throw new HttpError(400, 'expiresAt must be a future timestamp');
    expiresAt = t;
  }
  if (expiresAt > now() + MAX_RETENTION_DAYS * DAY_MS) throw new HttpError(400, `Retention cannot exceed ${MAX_RETENTION_DAYS} days from today`);
  q.updateTrip.run(name, startDate, endDate, expiresAt, trip.id);
  sendJson(res, 200, { trip: publicTrip(q.tripById.get(trip.id)) });
}

/** DELETE /api/trips/:code – remove the trip, its members, photos and files (owner only). */
async function apiDeleteTrip(req, res, code) {
  const trip = requireTrip(code);
  requireOwner(req, trip);
  q.deleteTrip.run(trip.id);
  q.deleteRetiredOfTrip.run(trip.id);
  await removeTripFiles(trip.id);
  sendJson(res, 200, { ok: true });
}

/** POST /api/trips/:code/rotate – issue a new code; the old link starts answering 410 (owner only). */
function apiRotateCode(req, res, code) {
  const trip = requireTrip(code);
  requireOwner(req, trip);
  let fresh = randomCode();
  while (q.tripByCode.get(fresh) || q.retiredByCode.get(fresh)) fresh = randomCode();
  q.setTripCode.run(fresh, trip.id);
  q.insertRetired.run(trip.code, trip.id, now());
  sendJson(res, 200, { trip: publicTrip(q.tripById.get(trip.id)), previousCode: trip.code });
}

/** DELETE /api/trips/:code/members/:id[?deletePhotos=1] – remove a member (owner only). */
async function apiRemoveMember(req, res, code, memberId) {
  const trip = requireTrip(code);
  const owner = requireOwner(req, trip);
  if (!ID_RE.test(memberId)) throw new HttpError(404, 'Member not found');
  const target = q.memberById.get(memberId, trip.id);
  if (!target || target.removed_at) throw new HttpError(404, 'Member not found');
  if (target.id === owner.id) throw new HttpError(400, 'The organiser cannot remove themselves');
  const deletePhotos = new URL(req.url, 'http://x').searchParams.get('deletePhotos') === '1';
  let removedPhotos = 0;
  if (deletePhotos) {
    const photos = q.photosOfMember.all(target.id);
    q.deletePhotosOfMember.run(target.id);
    await Promise.allSettled(photos.flatMap((p) => [fsp.unlink(photoPath(p)), fsp.unlink(photoPath(p, true))]));
    removedPhotos = photos.length;
  }
  q.removeMember.run(now(), target.id);
  sendJson(res, 200, { ok: true, removedPhotos });
}

/** PATCH /api/trips/:code/me – change own display name. */
async function apiUpdateMe(req, res, code) {
  const trip = requireTrip(code);
  const member = requireMember(req, trip);
  const body = await readJson(req);
  if (body.name === undefined) throw new HttpError(400, 'Nothing to update');
  const name = cleanName(body.name, member.name);
  q.renameMember.run(name, member.id);
  sendJson(res, 200, { member: { id: member.id, name, isOwner: trip.owner_member_id === member.id } });
}

function apiPushKey(req, res) {
  sendJson(res, 200, { publicKey: vapidKeys.publicKey });
}

async function apiPushSubscribe(req, res, code) {
  const trip = requireTrip(code);
  const member = requireMember(req, trip);
  const body = await readJson(req);
  const sub = body.subscription || body;
  const endpoint = String(sub.endpoint || '');
  const p256dh = String((sub.keys && sub.keys.p256dh) || '');
  const auth = String((sub.keys && sub.keys.auth) || '');
  let origin;
  try { origin = new URL(endpoint); } catch { throw new HttpError(400, 'Invalid push endpoint'); }
  if (!/^https?:$/.test(origin.protocol) || endpoint.length > 2048) throw new HttpError(400, 'Invalid push endpoint');
  if (Buffer.from(p256dh, 'base64url').length !== 65 || Buffer.from(auth, 'base64url').length !== 16) throw new HttpError(400, 'Invalid subscription keys');
  q.upsertPushSub.run(newId(), trip.id, member.id, endpoint, p256dh, auth, now());
  sendJson(res, 201, { ok: true });
}

async function apiPushUnsubscribe(req, res, code) {
  const trip = requireTrip(code);
  requireMember(req, trip);
  const body = await readJson(req);
  const endpoint = String((body.subscription && body.subscription.endpoint) || body.endpoint || '');
  q.deletePushSub.run(trip.id, endpoint);
  sendJson(res, 200, { ok: true });
}

function apiPushStatus(req, res, code) {
  const trip = requireTrip(code);
  const member = requireMember(req, trip);
  sendJson(res, 200, { subscribed: !!q.pushSubOfMember.get(trip.id, member.id), publicKey: vapidKeys.publicKey });
}

async function apiHealth(req, res) {
  const s = q.globalStats.get();
  let disk = null;
  try {
    const st = await fsp.statfs(DATA_DIR);
    disk = { freeBytes: st.bavail * st.bsize, totalBytes: st.blocks * st.bsize };
  } catch { /* statfs unsupported on this platform */ }
  sendJson(res, 200, {
    ok: true, time: now(), uptimeSeconds: Math.round((now() - STARTED_AT) / 1000),
    trips: s.trips, members: s.members, photos: s.photos, photoBytes: s.photo_bytes, disk,
    push: { pendingTrips: pushPending.size, recentDeliveries: pushLog.slice(-5) },
  });
}

async function apiJoinTrip(req, res, code) {
  const trip = requireTrip(code);
  const body = await readJson(req);
  const name = cleanName(body.name, 'Traveler');
  const memberId = newId();
  const token = newToken();
  q.insertMember.run(memberId, trip.id, name, token, now());
  sendJson(res, 201, { trip: publicTrip(trip), member: { id: memberId, name, token, isOwner: false } });
}

/**
 * GET /api/trips/:code/me – validate the stored token. Also accepts a *retired* code: a member who
 * still holds a valid token learns the trip's current code (strangers on the old link only get 410).
 */
function apiMe(req, res, code) {
  let trip;
  try { trip = requireTrip(code); }
  catch (err) {
    if (err.status !== 410) throw err;
    trip = q.tripById.get(q.retiredByCode.get(code).trip_id);
    if (!trip) throw err;
    requireMember(req, trip);   // not a member of that trip -> 401, so the link stays useless to outsiders
  }
  const m = requireMember(req, trip);
  sendJson(res, 200, { trip: publicTrip(trip), member: { id: m.id, name: m.name, isOwner: trip.owner_member_id === m.id } });
}

function apiMembers(req, res, code) {
  const trip = requireTrip(code);
  requireMember(req, trip);
  const members = q.membersOfTrip.all(trip.id).map((m) => ({
    id: m.id, name: m.name, joinedAt: m.joined_at, photoCount: m.photo_count, isOwner: m.id === trip.owner_member_id,
  }));
  sendJson(res, 200, { members });
}

function apiListPhotos(req, res, code) {
  const trip = requireTrip(code);
  requireMember(req, trip);
  const photos = q.photosOfTrip.all(trip.id).map((p) => publicPhoto(p, code));
  sendJson(res, 200, { photos });
}

async function apiUploadPhoto(req, res, code) {
  const trip = requireTrip(code);
  const member = requireMember(req, trip);
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_PHOTO_BYTES) throw new HttpError(413, 'Photo too large (max 25 MB)');
  const buf = await readBody(req, MAX_PHOTO_BYTES);
  const kind = sniffImage(buf);
  if (!kind) throw new HttpError(415, 'Unsupported image type (JPEG, PNG, WebP, HEIC)');
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const dup = q.photoByHash.get(trip.id, sha256);
  if (dup) {
    // Same bytes already in this trip: tell the client which photo it is so it can treat this as done.
    return sendJson(res, 409, { error: 'This exact photo is already in the trip', photo: publicPhoto(dup, code) });
  }
  let meta = {};
  try { meta = JSON.parse(req.headers['x-photo-meta'] || '{}'); } catch { meta = {}; }
  const id = newId();
  const ts = now();
  const takenAt = Number.isFinite(Number(meta.takenAt)) && meta.takenAt ? Number(meta.takenAt) : ts;
  const width = Number.isFinite(Number(meta.width)) && meta.width ? Number(meta.width) : null;
  const height = Number.isFinite(Number(meta.height)) && meta.height ? Number(meta.height) : null;
  const dir = path.join(PHOTO_DIR, trip.id);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, `${id}.${kind.ext}`), buf);
  q.insertPhoto.run(id, trip.id, member.id, kind.mime, kind.ext, buf.length, width, height, takenAt, ts, sha256);
  q.touchTrip.run(ts, ts + RETENTION_DAYS * DAY_MS, trip.id);
  queuePhotoPush(trip, member);
  const photo = q.photoById.get(id, trip.id);
  sendJson(res, 201, { photo: publicPhoto(photo, code) });
}

async function apiUploadThumb(req, res, code, photoId) {
  const trip = requireTrip(code);
  const member = requireMember(req, trip);
  if (!ID_RE.test(photoId)) throw new HttpError(404, 'Photo not found');
  const photo = q.photoById.get(photoId, trip.id);
  if (!photo) throw new HttpError(404, 'Photo not found');
  if (photo.member_id !== member.id) throw new HttpError(403, 'Not your photo');
  const buf = await readBody(req, MAX_THUMB_BYTES);
  const kind = sniffImage(buf);
  if (!kind || kind.mime !== 'image/jpeg') throw new HttpError(415, 'Thumbnail must be JPEG');
  await fsp.writeFile(photoPath(photo, true), buf);
  q.setThumb.run(photo.id);
  sendJson(res, 200, { ok: true });
}

function photoFileName(photo) {
  const d = new Date(photo.taken_at || photo.created_at);
  const stamp = d.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const who = (photo.member_name || 'member').replace(/[^\w-]+/g, '_').slice(0, 24);
  return `${stamp}_${who}_${photo.id.slice(0, 8)}.${photo.ext}`;
}

async function apiServePhoto(req, res, code, photoId, thumb) {
  const trip = requireTrip(code);
  if (!ID_RE.test(photoId)) throw new HttpError(404, 'Photo not found');
  const photo = q.photoById.get(photoId, trip.id);
  if (!photo) throw new HttpError(404, 'Photo not found');
  const useThumb = thumb && photo.has_thumb;
  const file = photoPath(photo, useThumb);
  let stat;
  try { stat = await fsp.stat(file); } catch { throw new HttpError(404, 'File missing'); }
  const download = new URL(req.url, 'http://x').searchParams.get('download') === '1';
  const headers = {
    'Content-Type': useThumb ? 'image/jpeg' : photo.mime,
    'Content-Length': stat.size,
    'Cache-Control': 'private, max-age=31536000, immutable',
  };
  if (download) headers['Content-Disposition'] = `attachment; filename="${photoFileName(photo)}"`;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

async function apiDeletePhoto(req, res, code, photoId) {
  const trip = requireTrip(code);
  const member = requireMember(req, trip);
  if (!ID_RE.test(photoId)) throw new HttpError(404, 'Photo not found');
  const photo = q.photoById.get(photoId, trip.id);
  if (!photo) throw new HttpError(404, 'Photo not found');
  const isOwner = trip.owner_member_id === member.id;
  if (photo.member_id !== member.id && !isOwner) throw new HttpError(403, 'Only the uploader or trip owner can delete');
  q.deletePhoto.run(photo.id);
  await Promise.allSettled([fsp.unlink(photoPath(photo)), fsp.unlink(photoPath(photo, true))]);
  sendJson(res, 200, { ok: true });
}

async function apiDownloadZip(req, res, code) {
  const trip = requireTrip(code);
  requireMember(req, trip);
  const photos = q.photosOfTripAsc.all(trip.id);
  if (!photos.length) throw new HttpError(404, 'No photos yet');
  const safeTrip = trip.name.replace(/[^\w-]+/g, '_').slice(0, 40) || 'trip';
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${safeTrip}_photos.zip"`,
    'Cache-Control': 'no-store',
  });
  await streamZip(res, photos.map((p) => ({
    name: `${safeTrip}/${photoFileName(p)}`,
    filePath: photoPath(p),
    mtime: p.taken_at || p.created_at,
  })));
}

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};
async function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) throw new HttpError(404, 'Not found');
  let stat;
  try { stat = await fsp.stat(file); } catch { return null; }
  if (!stat.isFile()) return null;
  const ext = path.extname(file);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': ext === '.html' || file.endsWith('sw.js') ? 'no-cache' : 'public, max-age=3600',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
  return true;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const m = req.method;

  if (p.startsWith('/api/')) {
    if (m === 'OPTIONS') { res.writeHead(204); return res.end(); }
    let mm;
    if (p === '/api/health' && m === 'GET') return apiHealth(req, res);
    if (p === '/api/push/key' && m === 'GET') return apiPushKey(req, res);
    if ((mm = p.match(/^\/api\/trips\/([^/]+)\/push$/)) && m === 'GET') return apiPushStatus(req, res, mm[1]);
    if ((mm = p.match(/^\/api\/trips\/([^/]+)\/push$/)) && m === 'POST') return apiPushSubscribe(req, res, mm[1]);
    if ((mm = p.match(/^\/api\/trips\/([^/]+)\/push$/)) && m === 'DELETE') return apiPushUnsubscribe(req, res, mm[1]);
    if (p === '/api/trips' && m === 'POST') return apiCreateTrip(req, res);
    if ((mm = p.match(/^\/api\/trips\/([^/]+)$/)) && m === 'GET') return apiGetTrip(req, res, mm[1]);
    if ((mm = p.match(/^\/api\/trips\/([^/]+)$/)) && m === 'PATCH') return apiUpdateTrip(req, res, mm[1]);
    if ((mm = p.match(/^\/api\/trips\/([^/]+)$/)) && m === 'DELETE') return apiDeleteTrip(req, res, mm[1]);
    if ((mm = p.match(/^\/api\/trips\/([^/]+)\/rotate$/)) && m === 'POST') return apiRotateCode(req, res, mm[1]);
    if ((mm = p.match(/^\/api\/trips\/([^/]+)\/join$/)) && m === 'POST') return apiJoinTrip(req, res, mm[1]);
    if ((mm = p.match(/^\/api\/trips\/([^/]+)\/me$/)) && m === 'GET') return apiMe(req, res, mm[1]);
    if ((mm = p.match(/^\/api\/trips\/([^/]+)\/me$/)) && m === 'PATCH') return apiUpdateMe(req, res, mm[1]);
    if ((mm = p.match(/^\/api\/trips\/([^/]+)\/members$/)) && m === 'GET') return apiMembers(req, res, mm[1]);
    if ((mm = p.match(/^\/api\/trips\/([^/]+)\/members\/([^/]+)$/)) && m === 'DELETE') return apiRemoveMember(req, res, mm[1], mm[2]);
    if ((mm = p.match(/^\/api\/trips\/([^/]+)\/photos$/)) && m === 'GET') return apiListPhotos(req, res, mm[1]);
    if ((mm = p.match(/^\/api\/trips\/([^/]+)\/photos$/)) && m === 'POST') return apiUploadPhoto(req, res, mm[1]);
    if ((mm = p.match(/^\/api\/trips\/([^/]+)\/photos\/([^/]+)\/thumb$/)) && m === 'POST') return apiUploadThumb(req, res, mm[1], mm[2]);
    if ((mm = p.match(/^\/api\/trips\/([^/]+)\/photos\/([^/]+)\/thumb$/)) && (m === 'GET' || m === 'HEAD')) return apiServePhoto(req, res, mm[1], mm[2], true);
    if ((mm = p.match(/^\/api\/trips\/([^/]+)\/photos\/([^/]+)\/file$/)) && (m === 'GET' || m === 'HEAD')) return apiServePhoto(req, res, mm[1], mm[2], false);
    if ((mm = p.match(/^\/api\/trips\/([^/]+)\/photos\/([^/]+)$/)) && m === 'DELETE') return apiDeletePhoto(req, res, mm[1], mm[2]);
    if ((mm = p.match(/^\/api\/trips\/([^/]+)\/download\.zip$/)) && m === 'GET') return apiDownloadZip(req, res, mm[1]);
    throw new HttpError(404, 'No such API route');
  }

  if (m !== 'GET' && m !== 'HEAD') throw new HttpError(405, 'Method not allowed');
  // Trip deep links (/t/<code>) and any unknown path load the SPA shell.
  if (p.startsWith('/t/') || p === '/') return serveStatic(req, res, '/index.html');
  const served = await serveStatic(req, res, p);
  if (served === null) return serveStatic(req, res, '/index.html');
}

// ---------------------------------------------------------------------------
// Request logging: one JSON line per request on stdout (LOG=off to silence)
// ---------------------------------------------------------------------------
function logRequest(req, res, ip, startedAt) {
  if (!LOG_REQUESTS) return;
  const line = {
    t: new Date().toISOString(), m: req.method, p: req.url.split('?')[0], s: res.statusCode,
    ms: Date.now() - startedAt, ip, ua: (req.headers['user-agent'] || '').slice(0, 80),
  };
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

const server = http.createServer(async (req, res) => {
  const startedAt = Date.now();
  const ip = req.socket.remoteAddress || 'unknown';
  res.on('finish', () => logRequest(req, res, ip, startedAt));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (rateLimited(ip)) return sendJson(res, 429, { error: 'Too many requests, slow down' });
  try {
    await route(req, res);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) sendJson(res, status, { error: err.message || 'Server error' });
    else res.end();
  }
});

if (require.main === module) {
  if (process.argv.includes('--sweep')) {
    // One-shot maintenance mode for cron: delete trips past their retention window.
    sweepExpired().then((n) => { console.log(`swept ${n} expired trip${n === 1 ? '' : 's'}`); db.close(); process.exit(0); })
      .catch((err) => { console.error(err); process.exit(1); });
  } else if (process.argv.includes('--send-recaps')) {
    sendRecaps().then((codes) => { console.log(`sent ${codes.length} recap${codes.length === 1 ? '' : 's'}${codes.length ? `: ${codes.join(', ')}` : ''}`); db.close(); process.exit(0); })
      .catch((err) => { console.error(err); process.exit(1); });
  } else {
    server.listen(PORT, HOST, () => {
      const bound = server.address().port;   // PORT=0 asks the OS for a free port
      console.log(`TripLink listening on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${bound}  (data: ${DATA_DIR})`);
    });
    let shuttingDown = false;
    const shutdown = (signal) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`${signal} received, closing server…`);
      // Deliver any batched "new photos" pushes before going down, then close.
      flushAllPhotoPush().catch(() => {}).finally(() => {
        server.close(() => { try { db.close(); } catch { /* already closed */ } process.exit(0); });
      });
      setTimeout(() => process.exit(1), 10000).unref();   // do not hang forever on stuck connections
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  }
}

module.exports = { server, db, DATA_DIR, sweepExpired, sendRecaps, flushPhotoPush, flushAllPhotoPush, vapidKeys };
