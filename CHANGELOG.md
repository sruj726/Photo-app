# Changelog

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
