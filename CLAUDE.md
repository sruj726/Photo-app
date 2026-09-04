# TripLink – instructions for Claude Code

TripLink is a camera app for groups on a trip: the organiser creates a trip, shares one link,
and every photo anyone takes lands in the same album. At the end anyone downloads one ZIP.
Read `docs/PRODUCT_SPEC.md` (what to build) and `docs/ADOPTION_PLAYBOOK.md` (why) before
starting any feature. The phased build plan is `docs/CLAUDE_CODE_PROMPT.md`.

## Commands

```bash
node server.js                 # run on http://localhost:8787  (PORT, DATA_DIR env vars)
npm test                       # API tests: node --test test/*.test.js
node --check public/app.js     # syntax check front-end (no build step)
```

Node 22.13+ is required (`node:sqlite`). There is no bundler, no TypeScript, no npm install.

## Layout

```
server.js                 HTTP server, router, SQLite schema, ZIP streaming (single file on purpose)
public/index.html         app shell
public/app.js             whole front-end: router, screens (home / join / camera / photos / share), IndexedDB upload queue
public/style.css          mobile-first dark theme
public/sw.js              service worker: shell cache + cached thumbnails
public/manifest.webmanifest, icon*.{svg,png}
test/api.test.js          end-to-end API tests against a real server on a temp DATA_DIR
docs/                     spec, playbook, build plan
data/                     runtime photos + triplink.db (git-ignored)
```

## Rules

1. **Zero runtime dependencies stay zero** unless a phase in the build plan explicitly adds one
   (e.g. `sharp` for server-side thumbnails, `@aws-sdk/client-s3` for object storage). Justify
   any new dependency in the commit message.
2. **The web link must always work without installing anything.** Never gate join, camera,
   gallery or download behind an install, an account or a phone number. Native wrappers are
   additive.
3. **Offline first.** Anything the user creates (photo, reaction, comment) goes into the
   IndexedDB queue first and syncs later. Never lose a photo because the network dropped.
4. **Privacy defaults**: EXIF stripped on re-encode, no third-party scripts, no analytics
   SDKs. Per-trip opt-ins only.
5. **Every feature ships with a test.** API behaviour → `test/api.test.js` (or a new
   `test/<feature>.test.js`). UI flows → extend the Playwright smoke script in `test/ui.smoke.js`
   (Chromium with `--use-fake-device-for-media-stream`). Run both before committing.
6. **Keep server.js readable**: split into `src/` modules only when it passes ~1000 lines, and
   do the split as its own commit with no behaviour change.
7. **Validate everything from the client**: trip codes match `^[a-z0-9]{6,16}$`, ids are UUIDs,
   images are sniffed by magic bytes, names are stripped of control characters and capped.
8. **Mobile Safari is a first-class target.** Test camera, install prompt text and file input
   behaviour against iOS assumptions (no `beforeinstallprompt`, HEIC from the camera roll).
9. Commit per feature with a message that names the phase from the build plan, e.g.
   `Phase 2: QR code on share screen`.

## Definition of done for a feature

- Spec section updated if behaviour changed.
- Tests added and `npm test` green; smoke script green if UI changed.
- Works with the server freshly started on an empty `DATA_DIR`.
- README API table updated for any new route.
