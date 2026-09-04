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
const webpush = require('./push.js');
const { openDb } = require('./src/db.js');
const { streamZip } = require('./src/zip.js');
const { createStorage } = require('./src/storage/index.js');
const media = require('./src/media.js');
const {
  HttpError, sendJson, readBody, readJson, cleanName, cleanDate, sniffImage,
  randomCode, newId, newToken, now, ID_RE, CODE_RE, DAY_MS,
} = require('./src/util.js');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');   // chunked-upload parts (always local)
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_PHOTO_BYTES = 25 * 1024 * 1024;     // direct (single request) upload limit
const MAX_ORIGINAL_BYTES = 60 * 1024 * 1024;  // untouched originals when "keep originals" is on
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;    // videos (chunked)
const MAX_VIDEO_SECONDS = 60;
const CHUNK_SIZE = 4 * 1024 * 1024;           // chunked upload part size
const MAX_THUMB_BYTES = 1 * 1024 * 1024;
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN || 240);
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS || 90);   // trips expire this long after the last upload
const MAX_RETENTION_DAYS = 365;
const LOG_REQUESTS = process.env.LOG !== 'off';
const STARTED_AT = Date.now();
const PUSH_SUBJECT = process.env.PUSH_SUBJECT || 'mailto:admin@example.com';   // VAPID contact, change in production
const PUSH_BATCH_MS = Number(process.env.PUSH_BATCH_MS || 30 * 60 * 1000);       // "N new photos" at most once per trip per window
const RECAP_AFTER_MS = Number(process.env.RECAP_AFTER_MS || 48 * 3600 * 1000);   // end-of-trip recap this long after the last upload
const BASE_URL = (process.env.TRIPLINK_BASE_URL || '').replace(/\/+$/, '');      // public URL used in share links, e.g. https://photos.example.com

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const storage = createStorage(DATA_DIR);

// ---------------------------------------------------------------------------
// Database (schema + prepared statements live in src/db.js)
// ---------------------------------------------------------------------------
const { db, q } = openDb(path.join(DATA_DIR, 'triplink.db'));

const vapidKeys = webpush.loadOrCreateKeys(path.join(DATA_DIR, 'vapid.json'));


// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------
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

/** Storage key of a media variant: 'file' (what the gallery shows), 'thumb' (JPEG poster), 'original' (untouched upload). */
function photoKey(photo, variant = 'file') {
  const name = variant === 'thumb' ? `${photo.id}.thumb.jpg`
    : variant === 'original' ? `${photo.id}.orig.${photo.original_ext}`
    : `${photo.id}.${photo.ext}`;
  return `photos/${photo.trip_id}/${name}`;
}
async function deletePhotoFiles(photo) {
  const keys = [photoKey(photo), photoKey(photo, 'thumb')];
  if (photo.original_ext) keys.push(photoKey(photo, 'original'));
  await Promise.allSettled(keys.map((k) => storage.delete(k)));
}

/** Sniff images *and* videos from magic bytes. */
function sniffMedia(buf) {
  const img = sniffImage(buf);
  if (img) return { ...img, kind: 'photo' };
  if (buf.length < 12) return null;
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return { mime: 'video/webm', ext: 'webm', kind: 'video' };
  if (buf.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buf.toString('ascii', 8, 12);
    if (brand === 'qt  ') return { mime: 'video/quicktime', ext: 'mov', kind: 'video' };
    if (/^(isom|iso2|iso4|iso5|iso6|mp41|mp42|avc1|hvc1|M4V |M4VP|MSNV|f4v |dash)$/.test(brand)) return { mime: 'video/mp4', ext: 'mp4', kind: 'video' };
  }
  return null;
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
    keepOriginals: !!trip.keep_originals,
    limits: { photoBytes: MAX_PHOTO_BYTES, originalBytes: MAX_ORIGINAL_BYTES, videoBytes: MAX_VIDEO_BYTES, videoSeconds: MAX_VIDEO_SECONDS, chunkBytes: CHUNK_SIZE },
    memberCount: stats.member_count,
    photoCount: stats.photo_count,
    totalBytes: stats.total_bytes,
  };
}

async function removeTripFiles(tripId) {
  await storage.deletePrefix(`photos/${tripId}/`);
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
  // Abandoned chunked uploads: parts older than two days.
  for (const u of q.staleUploads.all(at - 2 * DAY_MS)) {
    q.deleteUpload.run(u.id);
    await fsp.rm(path.join(UPLOAD_DIR, `${u.id}.part`), { force: true });
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
    kind: p.kind || 'photo',
    duration: p.duration || null,
    hasThumb: !!p.has_thumb,
    url: `/api/trips/${tripCode}/photos/${p.id}/file`,
    thumbUrl: p.has_thumb ? `/api/trips/${tripCode}/photos/${p.id}/thumb` : (p.kind === 'video' ? null : `/api/trips/${tripCode}/photos/${p.id}/file`),
    originalUrl: p.original_ext ? `/api/trips/${tripCode}/photos/${p.id}/original` : null,
    originalSize: p.original_size || null,
    hearts: p.hearts || 0,
    favourited: !!p.favourited,
    commentCount: p.comment_count || 0,
  };
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
  const keepOriginals = body.keepOriginals !== undefined ? (body.keepOriginals ? 1 : 0) : trip.keep_originals;
  q.updateTrip.run(name, startDate, endDate, expiresAt, keepOriginals, trip.id);
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
    for (const p of photos) await deletePhotoFiles(p);
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
    storage: storage.kind, imageProcessing: media.available() ? 'sharp' : 'client-only',
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
  const member = requireMember(req, trip);
  const photos = q.photosOfTrip.all(member.id, trip.id).map((p) => publicPhoto(p, code));
  sendJson(res, 200, { photos });
}

function requireTripPhoto(req, code, photoId) {
  const trip = requireTrip(code);
  const member = requireMember(req, trip);
  if (!ID_RE.test(photoId)) throw new HttpError(404, 'Photo not found');
  const photo = q.photoById.get(photoId, trip.id);
  if (!photo) throw new HttpError(404, 'Photo not found');
  return { trip, member, photo };
}

/** POST / DELETE /api/trips/:code/photos/:id/favourite – heart or un-heart (one per member). */
function apiFavourite(req, res, code, photoId, on) {
  const { member, photo } = requireTripPhoto(req, code, photoId);
  if (on) q.addFavourite.run(photo.id, member.id, now()); else q.removeFavourite.run(photo.id, member.id);
  sendJson(res, 200, { favourited: on, hearts: q.heartCount.get(photo.id).n });
}

const MAX_COMMENT_CHARS = 280;
function publicComment(c) {
  return { id: c.id, text: c.text, createdAt: c.created_at, memberId: c.member_id, memberName: c.member_name };
}
function apiListComments(req, res, code, photoId) {
  const { photo } = requireTripPhoto(req, code, photoId);
  sendJson(res, 200, { comments: q.commentsOfPhoto.all(photo.id).map(publicComment) });
}
async function apiAddComment(req, res, code, photoId) {
  const { member, photo } = requireTripPhoto(req, code, photoId);
  const body = await readJson(req);
  const text = String(body.text ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!text) throw new HttpError(400, 'Comment is empty');
  if ([...text].length > MAX_COMMENT_CHARS) throw new HttpError(400, `Comments are limited to ${MAX_COMMENT_CHARS} characters`);
  const id = newId();
  q.insertComment.run(id, photo.id, member.id, text, now());
  const c = q.commentsOfPhoto.all(photo.id).find((x) => x.id === id);
  sendJson(res, 201, { comment: publicComment(c) });
}
async function apiDeleteComment(req, res, code, photoId, commentId) {
  const { trip, member, photo } = requireTripPhoto(req, code, photoId);
  if (!ID_RE.test(commentId)) throw new HttpError(404, 'Comment not found');
  const c = q.commentById.get(commentId, photo.id);
  if (!c) throw new HttpError(404, 'Comment not found');
  if (c.member_id !== member.id && trip.owner_member_id !== member.id) throw new HttpError(403, 'Only the author or the organiser can delete a comment');
  q.deleteComment.run(c.id);
  sendJson(res, 200, { ok: true });
}

/**
 * Store one photo or video for a trip. Shared by the direct upload and the chunked upload.
 * Returns { status, body } – 201 with the photo, or 409 with the duplicate.
 */
async function storeMedia(trip, member, buf, meta = {}) {
  const kind = sniffMedia(buf);
  if (!kind) throw new HttpError(415, 'Unsupported file type (JPEG, PNG, WebP, HEIC, MP4, MOV, WebM)');
  if (kind.kind === 'video' && buf.length > MAX_VIDEO_BYTES) throw new HttpError(413, 'Video too large (max 200 MB)');
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const dup = q.photoByHash.get(trip.id, sha256);
  if (dup) return { status: 409, body: { error: 'This exact photo is already in the trip', photo: publicPhoto(dup, trip.code) } };

  const id = newId();
  const ts = now();
  const takenAt = Number.isFinite(Number(meta.takenAt)) && meta.takenAt ? Number(meta.takenAt) : ts;
  let width = Number.isFinite(Number(meta.width)) && meta.width ? Number(meta.width) : null;
  let height = Number.isFinite(Number(meta.height)) && meta.height ? Number(meta.height) : null;
  const duration = kind.kind === 'video' && Number.isFinite(Number(meta.duration)) ? Math.min(Number(meta.duration), MAX_VIDEO_SECONDS * 2) : null;

  let main = { buf, mime: kind.mime, ext: kind.ext };
  let original = null;              // { buf, ext } – stored when the trip keeps originals
  let thumb = null;
  if (kind.kind === 'photo' && media.available()) {
    if (kind.mime === 'image/heic' || kind.mime === 'image/avif') {
      // Browsers cannot show HEIC (and AVIF support is patchy): convert, keep the bytes only if the trip keeps originals.
      try {
        const j = await media.toJpeg(buf);
        main = { buf: j.buffer, mime: 'image/jpeg', ext: 'jpg' };
        width = j.width; height = j.height;
        if (trip.keep_originals) original = { buf, ext: kind.ext };
      } catch (err) { console.error('HEIC conversion failed, storing as-is:', err.message); }
    }
    if (!width || !height) { const d = await media.dimensions(main.buf); if (d) ({ width, height } = d); }
    try { thumb = await media.thumbnail(main.buf); } catch (err) { console.error('thumbnail failed:', err.message); }
  }

  const photoRow = { id, trip_id: trip.id, ext: main.ext, original_ext: original ? original.ext : null };
  await storage.put(photoKey(photoRow), main.buf);
  if (thumb) await storage.put(photoKey(photoRow, 'thumb'), thumb);
  if (original) await storage.put(photoKey(photoRow, 'original'), original.buf);
  q.insertPhoto.run(id, trip.id, member.id, main.mime, main.ext, main.buf.length, width, height, takenAt, ts, thumb ? 1 : 0, sha256, kind.kind, duration);
  if (original) q.setOriginal.run(original.ext, original.buf.length, id);
  q.touchTrip.run(ts, ts + RETENTION_DAYS * DAY_MS, trip.id);
  queuePhotoPush(trip, member);
  return { status: 201, body: { photo: publicPhoto(q.photoById.get(id, trip.id), trip.code) } };
}

function parseMetaHeader(req) {
  try { return JSON.parse(req.headers['x-photo-meta'] || '{}'); } catch { return {}; }
}

async function apiUploadPhoto(req, res, code) {
  const trip = requireTrip(code);
  const member = requireMember(req, trip);
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_PHOTO_BYTES) throw new HttpError(413, 'Too large for a direct upload (max 25 MB) – use the chunked upload');
  const buf = await readBody(req, MAX_PHOTO_BYTES);
  const r = await storeMedia(trip, member, buf, parseMetaHeader(req));
  sendJson(res, r.status, r.body);
}

function requireOwnPhoto(req, code, photoId) {
  const trip = requireTrip(code);
  const member = requireMember(req, trip);
  if (!ID_RE.test(photoId)) throw new HttpError(404, 'Photo not found');
  const photo = q.photoById.get(photoId, trip.id);
  if (!photo) throw new HttpError(404, 'Photo not found');
  if (photo.member_id !== member.id) throw new HttpError(403, 'Not your photo');
  return { trip, member, photo };
}

async function apiUploadThumb(req, res, code, photoId) {
  const { photo } = requireOwnPhoto(req, code, photoId);
  const buf = await readBody(req, MAX_THUMB_BYTES);
  const kind = sniffImage(buf);
  if (!kind || kind.mime !== 'image/jpeg') throw new HttpError(415, 'Thumbnail must be JPEG');
  await storage.put(photoKey(photo, 'thumb'), buf);
  q.setThumb.run(photo.id);
  sendJson(res, 200, { ok: true });
}

/** POST /api/trips/:code/photos/:id/original – the untouched file, only when the trip keeps originals. */
async function apiUploadOriginal(req, res, code, photoId) {
  const { trip, photo } = requireOwnPhoto(req, code, photoId);
  if (!trip.keep_originals) throw new HttpError(400, 'This trip does not keep originals');
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_ORIGINAL_BYTES) throw new HttpError(413, 'Original too large (max 60 MB)');
  const buf = await readBody(req, MAX_ORIGINAL_BYTES);
  const kind = sniffMedia(buf);
  if (!kind) throw new HttpError(415, 'Unsupported file type');
  if (photo.original_ext) await storage.delete(photoKey(photo, 'original'));
  await storage.put(photoKey({ ...photo, original_ext: kind.ext }, 'original'), buf);
  q.setOriginal.run(kind.ext, buf.length, photo.id);
  sendJson(res, 200, { ok: true, originalUrl: `/api/trips/${code}/photos/${photo.id}/original`, originalSize: buf.length });
}

// ---- Chunked, resumable uploads (for files > 8 MB, videos, flaky networks)
async function apiUploadInit(req, res, code) {
  const trip = requireTrip(code);
  const member = requireMember(req, trip);
  const body = await readJson(req);
  const size = Number(body.size);
  if (!Number.isInteger(size) || size <= 0) throw new HttpError(400, 'size is required');
  if (size > MAX_VIDEO_BYTES) throw new HttpError(413, 'File too large (max 200 MB)');
  const meta = { takenAt: body.takenAt, width: body.width, height: body.height, duration: body.duration };
  const id = newId();
  const ts = now();
  q.insertUpload.run(id, trip.id, member.id, size, JSON.stringify(meta), ts, ts);
  await fsp.writeFile(path.join(UPLOAD_DIR, `${id}.part`), Buffer.alloc(0));
  sendJson(res, 201, { uploadId: id, chunkBytes: CHUNK_SIZE, received: 0 });
}

function requireUpload(req, code, uploadId) {
  const trip = requireTrip(code);
  const member = requireMember(req, trip);
  if (!ID_RE.test(uploadId)) throw new HttpError(404, 'Upload not found');
  const up = q.uploadById.get(uploadId, trip.id);
  if (!up || up.member_id !== member.id) throw new HttpError(404, 'Upload not found');
  return { trip, member, up };
}

function apiUploadStatus(req, res, code, uploadId) {
  const { up } = requireUpload(req, code, uploadId);
  sendJson(res, 200, { uploadId: up.id, size: up.size, received: up.received, chunkBytes: CHUNK_SIZE });
}

async function apiUploadChunk(req, res, code, uploadId) {
  const { up } = requireUpload(req, code, uploadId);
  const offset = Number(new URL(req.url, 'http://x').searchParams.get('offset'));
  if (!Number.isInteger(offset) || offset !== up.received) {
    return sendJson(res, 409, { error: `Expected offset ${up.received}`, received: up.received });
  }
  const chunk = await readBody(req, CHUNK_SIZE);
  if (!chunk.length) throw new HttpError(400, 'Empty chunk');
  if (up.received + chunk.length > up.size) throw new HttpError(400, 'Chunk exceeds declared size');
  await fsp.appendFile(path.join(UPLOAD_DIR, `${up.id}.part`), chunk);
  q.setUploadReceived.run(up.received + chunk.length, now(), up.id);
  sendJson(res, 200, { received: up.received + chunk.length, size: up.size });
}

async function apiUploadComplete(req, res, code, uploadId) {
  const { trip, member, up } = requireUpload(req, code, uploadId);
  if (up.received !== up.size) throw new HttpError(409, `Upload incomplete: ${up.received} of ${up.size} bytes`);
  const partPath = path.join(UPLOAD_DIR, `${up.id}.part`);
  const buf = await fsp.readFile(partPath);
  let meta = {};
  try { meta = JSON.parse(up.meta); } catch { meta = {}; }
  let r;
  try { r = await storeMedia(trip, member, buf, meta); }
  finally { q.deleteUpload.run(up.id); await fsp.rm(partPath, { force: true }); }
  sendJson(res, r.status, r.body);
}

async function apiUploadAbort(req, res, code, uploadId) {
  const { up } = requireUpload(req, code, uploadId);
  q.deleteUpload.run(up.id);
  await fsp.rm(path.join(UPLOAD_DIR, `${up.id}.part`), { force: true });
  sendJson(res, 200, { ok: true });
}

function photoFileName(photo, ext = photo.ext) {
  const d = new Date(photo.taken_at || photo.created_at);
  const stamp = d.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const who = (photo.member_name || 'member').replace(/[^\w-]+/g, '_').slice(0, 24);
  return `${stamp}_${who}_${photo.id.slice(0, 8)}.${ext}`;
}

const MEDIA_MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', avif: 'image/avif', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' };

async function apiServePhoto(req, res, code, photoId, variant) {
  const trip = requireTrip(code);
  if (!ID_RE.test(photoId)) throw new HttpError(404, 'Photo not found');
  const photo = q.photoById.get(photoId, trip.id);
  if (!photo) throw new HttpError(404, 'Photo not found');
  if (variant === 'thumb' && !photo.has_thumb) variant = 'file';
  if (variant === 'original' && !photo.original_ext) throw new HttpError(404, 'No original kept for this photo');
  const found = await storage.stream(photoKey(photo, variant));
  if (!found) throw new HttpError(404, 'File missing');
  const download = new URL(req.url, 'http://x').searchParams.get('download') === '1';
  const mime = variant === 'thumb' ? 'image/jpeg' : variant === 'original' ? (MEDIA_MIME[photo.original_ext] || 'application/octet-stream') : photo.mime;
  const headers = {
    'Content-Type': mime,
    'Content-Length': found.size,
    'Cache-Control': 'private, max-age=31536000, immutable',
  };
  if (download) headers['Content-Disposition'] = `attachment; filename="${photoFileName(photo, variant === 'original' ? photo.original_ext : photo.ext)}"`;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') { found.stream.destroy(); return res.end(); }
  found.stream.pipe(res);
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
  await deletePhotoFiles(photo);
  sendJson(res, 200, { ok: true });
}

async function apiDownloadZip(req, res, code) {
  const trip = requireTrip(code);
  const member = requireMember(req, trip);
  const params = new URL(req.url, 'http://x').searchParams;
  const onlyFavourites = params.get('favourites') === '1';
  const photos = onlyFavourites ? q.favouritesOfMemberAsc.all(member.id, trip.id) : q.photosOfTripAsc.all(trip.id);
  if (!photos.length) throw new HttpError(404, onlyFavourites ? 'You have no favourites yet' : 'No photos yet');
  const safeTrip = trip.name.replace(/[^\w-]+/g, '_').slice(0, 40) || 'trip';
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${safeTrip}_${onlyFavourites ? 'favourites' : 'photos'}.zip"`,
    'Cache-Control': 'no-store',
  });
  // When the trip keeps originals, the zip carries the untouched files.
  await streamZip(res, photos.map((p) => {
    const useOriginal = !!(trip.keep_originals && p.original_ext);
    return {
      name: `${safeTrip}/${photoFileName(p, useOriginal ? p.original_ext : p.ext)}`,
      read: () => storage.get(photoKey(p, useOriginal ? 'original' : 'file')),
      mtime: p.taken_at || p.created_at,
    };
  }));
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
    if ((mm = p.match(/^\/api\/trips\/([^/]+)\/photos\/([^/]+)\/original$/)) && m === 'POST') return apiUploadOriginal(req, res, mm[1], mm[2]);
    if ((mm = p.match(/^\/api\/trips\/([^/]+)\/photos\/([^/]+)\/favourite$/)) && m === 'POST') return apiFavourite(req, res, mm[1], mm[2], true);
    if ((mm = p.match(/^\/api\/trips\/([^/]+)\/photos\/([^/]+)\/favourite$/)) && m === 'DELETE') return apiFavourite(req, res, mm[1], mm[2], false);
    if ((mm = p.match(/^\/api\/trips\/([^/]+)\/photos\/([^/]+)\/comments$/)) && m === 'GET') return apiListComments(req, res, mm[1], mm[2]);
    if ((mm = p.match(/^\/api\/trips\/([^/]+)\/photos\/([^/]+)\/comments$/)) && m === 'POST') return apiAddComment(req, res, mm[1], mm[2]);
    if ((mm = p.match(/^\/api\/trips\/([^/]+)\/photos\/([^/]+)\/comments\/([^/]+)$/)) && m === 'DELETE') return apiDeleteComment(req, res, mm[1], mm[2], mm[3]);
    if ((mm = p.match(/^\/api\/trips\/([^/]+)\/photos\/([^/]+)\/(thumb|file|original)$/)) && (m === 'GET' || m === 'HEAD')) return apiServePhoto(req, res, mm[1], mm[2], mm[3]);
    if ((mm = p.match(/^\/api\/trips\/([^/]+)\/uploads$/)) && m === 'POST') return apiUploadInit(req, res, mm[1]);
    if ((mm = p.match(/^\/api\/trips\/([^/]+)\/uploads\/([^/]+)$/)) && m === 'GET') return apiUploadStatus(req, res, mm[1], mm[2]);
    if ((mm = p.match(/^\/api\/trips\/([^/]+)\/uploads\/([^/]+)$/)) && m === 'PUT') return apiUploadChunk(req, res, mm[1], mm[2]);
    if ((mm = p.match(/^\/api\/trips\/([^/]+)\/uploads\/([^/]+)$/)) && m === 'DELETE') return apiUploadAbort(req, res, mm[1], mm[2]);
    if ((mm = p.match(/^\/api\/trips\/([^/]+)\/uploads\/([^/]+)\/complete$/)) && m === 'POST') return apiUploadComplete(req, res, mm[1], mm[2]);
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

module.exports = { server, db, DATA_DIR, storage, sweepExpired, sendRecaps, flushPhotoPush, flushAllPhotoPush, vapidKeys };
