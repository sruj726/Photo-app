# Changelog

## 0.8.0 – Phase 7: opt-in intelligence
- Per-trip `ai` flags (bestShot, faces, people, map), each off by default, in trip settings with privacy notes.
- Best shot: sharpness measured on the phone (`public/ml/quality.js`), stored only when enabled; bursts collapse to the sharpest with a "+N" badge and a "Show all shots" toggle.
- Photos of me: `public/ml/face.js` – Shape Detection API where available, pluggable embedder, on-device matching against a selfie, "🙂 Me" filter.
- Group photos: `node server.js --tag-people` runs `ml/people.py` (YOLOv8, ultralytics) or any `TAGGER_CMD`; retries capped at 3; "👥 Group photos" filter for 3+ people.
- Map: location captured with the shutter when enabled (client geolocation), `public/ml/geo.js` Web Mercator + clustering, OpenStreetMap tiles fetched only while the map is open, day list.

## 0.7.0 – Phase 6: store presence and native capabilities
- `/.well-known/assetlinks.json` and `/.well-known/apple-app-site-association` generated from env for App Links / Universal Links.
- Web Share Target: `sw.js` accepts POST /share-target, queues shared photos/videos for the last opened trip (IndexedDB `meta` store, DB v2) and redirects into the trip.
- `native/android`: Trusted Web Activity project (manifest, Gradle, asset statements, release checklist).
- `native/ios`: Capacitor config, `TripLinkNative` Swift plugin (background URLSession uploads, thumb/original follow-ups) with JS bridge; `app.js` hands uploads to the bridge when present.
- `docs/APP_CLIPS.md`: App Clip / Instant App feasibility – not worth building.

## 0.6.0 – Phase 5: access modes and organisations
- Join approval mode: pending members wait on a self-updating screen; organisers approve/reject from the Share tab (pending list refreshes every 8 s).
- PIN mode: 4–8 digits, scrypt-hashed, join attempts rate-limited per IP and trip; PIN entry on the join screen.
- Co-organisers: owner promotes/demotes; organisers manage members, settings, rotation, moderation; owner-only delete/roles; organisers cannot remove other organisers.
- Photo reports: hidden for the reporter immediately, "🚩 Reported" chip and Keep/Delete for organisers.
- School preset: approval on, first-name wording, comments off, 30-day retention (expiry pulled in), toggle back off.
- Branding: accent colour (with readable text colour) applied per trip, logo upload shown on join screen, header and printable card.

## 0.5.0 – Phase 4: browsing and organising
- Gallery moved to `public/gallery.js`: day sections with sticky headers, filter chips (all / ♥ favourites / 🎥 videos / per person).
- Windowed grid: only rows near the viewport are rendered (240-photo trip renders ~20 tiles in the smoke test).
- Hearts (one per member) with counts on tiles and in the lightbox; "Download my favourites" zip.
- Comments per photo (280 chars), author/organiser delete, counts on tiles; queued in IndexedDB when offline and posted by the sync loop.
- Lightbox: swipe to navigate, pinch to zoom, double-tap 2×, arrow keys / Escape, neighbour preloading.
- Export sheet: zip all, zip favourites, save every file into a folder (File System Access API), platform steps for Google Photos and iCloud.

## 0.4.0 – Phase 3: media quality and volume
- Storage abstraction (`src/storage/`): local disk or S3-compatible (SigV4 without an SDK, verified against the AWS reference vector and a fake S3 server).
- Optional `sharp`: server-side thumbnails, dimensions, HEIC/AVIF → JPEG; graceful fallback to client-only when not installed.
- "Keep originals" per trip: untouched files stored and served, ZIP carries originals.
- Video: 60 s recording from a 1280 px canvas stream, gallery import, poster frame, playback in the lightbox; magic-byte sniffing for MP4/MOV/WebM; 200 MB cap.
- Resumable chunked uploads for files above 8 MB (init / PUT chunk / complete / abort, resume after reload, stale parts swept).
- Wi-Fi-only and pause toggles; upload queue drains items added mid-sync.
- Refactor: `src/db.js`, `src/util.js`, `src/zip.js`, `src/media.js`.

## 0.3.0 – Phase 2: adoption features
- Client-side QR encoder (`public/qr.js`, byte mode, EC-M, v1–10) verified module-for-module against two independent encoders; QR on the Share tab and a printable A5 join card at `/t/<code>/card`.
- Pre-written share message with WhatsApp / Telegram / SMS / copy buttons; `TRIPLINK_BASE_URL` for links behind a proxy.
- "Who's missing" banner for an organiser whose trip is 24 h old with fewer than 3 members.
- Web Push without third-party services: VAPID + aes128gcm in `push.js`; opt-in banner after the first upload; notification toggle on Share; "N new photos from …" batched per trip (30 min); recap 48 h after the last upload (`--send-recaps` for cron); gone endpoints pruned.
- Reciprocity nudge on the Photos tab with a one-tap jump to the camera.
- iOS Safari install sheet shown once when the gallery is first opened.
- Smoke test runs in full headless Chromium (notification permission), covers all of the above.

## 0.2.0 – Phase 1: trustworthy for a real trip
- Browser smoke test (`npm run smoke`): headless Chromium with a fake camera drives every user flow.
- Trip settings for the organiser: rename, start/end dates (`PATCH /api/trips/:code`).
- Delete trip with two-step confirmation; removes rows and files (`DELETE /api/trips/:code`).
- Member management: organiser removes a member (token stops working), optionally with their photos; members rename themselves.
- Link rotation: new code on demand, old link answers 410 with an "expired" screen; existing members are forwarded automatically.
- Duplicate protection: SHA-256 per photo, identical bytes in a trip answer 409 and the client treats it as done.
- Retention: trips expire 90 days after the last upload (configurable), owner can extend up to 365 days, "kept until" shown on Photos and Share, `node server.js --sweep` for cron.
- Ops: `/api/health` with counts, disk and uptime; JSON request log; graceful SIGTERM shutdown; correct port printed when `PORT=0`.

## 0.1.0 – prototype
- Trips with share link and code, join by link, per-device member tokens, owner role.
- Live camera capture, gallery import, client-side resize, offline IndexedDB upload queue.
- Gallery grid, lightbox, per-photo save, delete (uploader/owner).
- Download-all streamed ZIP with chronological, per-person file names.
- Installable PWA with service worker; zero-dependency Node 22 server with SQLite.
- End-to-end API tests.
