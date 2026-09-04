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
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS members (
    id TEXT PRIMARY KEY,
    trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token TEXT UNIQUE NOT NULL,
    joined_at INTEGER NOT NULL
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
    has_thumb INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS photos_trip ON photos(trip_id, created_at);
`);

const q = {
  insertTrip: db.prepare('INSERT INTO trips (id, code, name, owner_member_id, created_at) VALUES (?, ?, ?, ?, ?)'),
  setOwner: db.prepare('UPDATE trips SET owner_member_id = ? WHERE id = ?'),
  tripByCode: db.prepare('SELECT * FROM trips WHERE code = ?'),
  tripStats: db.prepare(`SELECT
      (SELECT COUNT(*) FROM members WHERE trip_id = ?) AS member_count,
      (SELECT COUNT(*) FROM photos  WHERE trip_id = ?) AS photo_count,
      (SELECT COALESCE(SUM(size),0) FROM photos WHERE trip_id = ?) AS total_bytes`),
  insertMember: db.prepare('INSERT INTO members (id, trip_id, name, token, joined_at) VALUES (?, ?, ?, ?, ?)'),
  memberByToken: db.prepare('SELECT * FROM members WHERE token = ?'),
  membersOfTrip: db.prepare(`SELECT m.id, m.name, m.joined_at,
        (SELECT COUNT(*) FROM photos p WHERE p.member_id = m.id) AS photo_count
      FROM members m WHERE m.trip_id = ? ORDER BY m.joined_at`),
  insertPhoto: db.prepare(`INSERT INTO photos (id, trip_id, member_id, mime, ext, size, width, height, taken_at, created_at, has_thumb)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`),
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
  if (!trip) throw new HttpError(404, 'Trip not found');
  return trip;
}

function requireMember(req, trip) {
  const token = req.headers['x-member-token'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token || typeof token !== 'string' || token.length > 128) throw new HttpError(401, 'Join the trip first');
  const member = q.memberByToken.get(token);
  if (!member || member.trip_id !== trip.id) throw new HttpError(401, 'Join the trip first');
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
    memberCount: stats.member_count,
    photoCount: stats.photo_count,
    totalBytes: stats.total_bytes,
  };
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
  q.insertTrip.run(tripId, code, name, null, ts);
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

async function apiJoinTrip(req, res, code) {
  const trip = requireTrip(code);
  const body = await readJson(req);
  const name = cleanName(body.name, 'Traveler');
  const memberId = newId();
  const token = newToken();
  q.insertMember.run(memberId, trip.id, name, token, now());
  sendJson(res, 201, { trip: publicTrip(trip), member: { id: memberId, name, token, isOwner: false } });
}

function apiMe(req, res, code) {
  const trip = requireTrip(code);
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
  q.insertPhoto.run(id, trip.id, member.id, kind.mime, kind.ext, buf.length, width, height, takenAt, ts);
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
    if (p === '/api/health' && m === 'GET') return sendJson(res, 200, { ok: true, time: now() });
    if (p === '/api/trips' && m === 'POST') return apiCreateTrip(req, res);
    if ((mm = p.match(/^\/api\/trips\/([^/]+)$/)) && m === 'GET') return apiGetTrip(req, res, mm[1]);
    if ((mm = p.match(/^\/api\/trips\/([^/]+)\/join$/)) && m === 'POST') return apiJoinTrip(req, res, mm[1]);
    if ((mm = p.match(/^\/api\/trips\/([^/]+)\/me$/)) && m === 'GET') return apiMe(req, res, mm[1]);
    if ((mm = p.match(/^\/api\/trips\/([^/]+)\/members$/)) && m === 'GET') return apiMembers(req, res, mm[1]);
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

const server = http.createServer(async (req, res) => {
  const ip = req.socket.remoteAddress || 'unknown';
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
  server.listen(PORT, HOST, () => {
    console.log(`TripLink listening on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}  (data: ${DATA_DIR})`);
  });
}

module.exports = { server, db, DATA_DIR };
