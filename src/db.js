'use strict';
/* SQLite schema, additive migrations and every prepared statement the server uses. */
const { DatabaseSync } = require('node:sqlite');

function openDb(file) {
  const db = new DatabaseSync(file);
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
      last_activity_at INTEGER,
      recap_sent_at INTEGER
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
  ensureColumn('trips', 'keep_originals', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('members', 'removed_at', 'INTEGER');
  ensureColumn('photos', 'sha256', 'TEXT');
  ensureColumn('photos', 'kind', "TEXT NOT NULL DEFAULT 'photo'");   // 'photo' | 'video'
  ensureColumn('photos', 'duration', 'REAL');
  ensureColumn('photos', 'original_ext', 'TEXT');                     // set when an untouched original is stored too
  ensureColumn('photos', 'original_size', 'INTEGER');
  db.exec(`
    CREATE INDEX IF NOT EXISTS photos_hash ON photos(trip_id, sha256);
    CREATE TABLE IF NOT EXISTS uploads (
      id TEXT PRIMARY KEY,
      trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      size INTEGER NOT NULL,
      received INTEGER NOT NULL DEFAULT 0,
      meta TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  const q = {
    insertTrip: db.prepare('INSERT INTO trips (id, code, name, owner_member_id, created_at, expires_at, last_activity_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    setOwner: db.prepare('UPDATE trips SET owner_member_id = ? WHERE id = ?'),
    tripByCode: db.prepare('SELECT * FROM trips WHERE code = ?'),
    tripById: db.prepare('SELECT * FROM trips WHERE id = ?'),
    updateTrip: db.prepare('UPDATE trips SET name = ?, start_date = ?, end_date = ?, expires_at = ?, keep_originals = ? WHERE id = ?'),
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
    insertPhoto: db.prepare(`INSERT INTO photos (id, trip_id, member_id, mime, ext, size, width, height, taken_at, created_at, has_thumb, sha256, kind, duration)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    photoByHash: db.prepare(`SELECT p.*, m.name AS member_name FROM photos p JOIN members m ON m.id = p.member_id
        WHERE p.trip_id = ? AND p.sha256 = ?`),
    setThumb: db.prepare('UPDATE photos SET has_thumb = 1 WHERE id = ?'),
    setOriginal: db.prepare('UPDATE photos SET original_ext = ?, original_size = ? WHERE id = ?'),
    photoById: db.prepare(`SELECT p.*, m.name AS member_name FROM photos p JOIN members m ON m.id = p.member_id
        WHERE p.id = ? AND p.trip_id = ?`),
    photosOfTrip: db.prepare(`SELECT p.id, p.mime, p.size, p.width, p.height, p.taken_at, p.created_at, p.has_thumb,
          p.member_id, p.kind, p.duration, p.original_ext, p.original_size, m.name AS member_name
        FROM photos p JOIN members m ON m.id = p.member_id
        WHERE p.trip_id = ? ORDER BY COALESCE(p.taken_at, p.created_at) DESC, p.created_at DESC`),
    insertUpload: db.prepare('INSERT INTO uploads (id, trip_id, member_id, size, received, meta, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)'),
    uploadById: db.prepare('SELECT * FROM uploads WHERE id = ? AND trip_id = ?'),
    setUploadReceived: db.prepare('UPDATE uploads SET received = ?, updated_at = ? WHERE id = ?'),
    deleteUpload: db.prepare('DELETE FROM uploads WHERE id = ?'),
    staleUploads: db.prepare('SELECT * FROM uploads WHERE updated_at < ?'),
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

  return { db, q, ensureColumn };
}

module.exports = { openDb };
