# Photo-app (TripLink) – one link for every photo from the trip

A camera app for groups on a trip. The organiser creates a **trip**, gets **one link**, and
everyone who opens the link becomes part of that trip. Every photo anyone takes through the
app (or adds from their gallery) lands in the same album. At the end, anyone taps
**Download all** and gets a single `.zip` with every photo from every phone.

No sign-up, no app store, no build step. The only dependency is optional (`sharp`, for
server-side thumbnails and HEIC conversion); without it everything still works.

* `server.js` – Node 22 backend: JSON API, SQLite (built-in `node:sqlite`), photo storage, ZIP streaming.
* `public/` – installable PWA: live camera, gallery, share screen, offline upload queue, service worker.
* `test/` – end-to-end API tests (`node --test`).
* `docs/PRODUCT_SPEC.md` – every aspect of the product (flows, features, architecture, privacy, costs, risks, roadmap).
* `docs/ADOPTION_PLAYBOOK.md` – how to make sure every person on the trip actually uses it.
* `docs/CLAUDE_CODE_PROMPT.md` – phased build plan with paste-able prompts for Claude Code.
* `CLAUDE.md` – project rules Claude Code reads automatically.

## Run it

```bash
git clone https://github.com/sruj726/Photo-app && cd Photo-app
node server.js            # http://localhost:8787
npm test                  # API tests (node --test)
npm run smoke             # browser smoke test in headless Chromium with a fake camera
npm run sweep             # delete trips past their retention window, then exit (for cron)
```

Requires Node **22.13+** (for `node:sqlite`). Photos and the database are written to `./data`
(override with `DATA_DIR=/somewhere`). Port with `PORT=…`.

The smoke test needs Playwright + Chromium once per machine:
`npm i -g playwright && npx playwright install chromium` (a local `npm install` works too).

| Env var | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | `8787` / `0.0.0.0` | Listen address. `PORT=0` picks a free port and prints it. |
| `DATA_DIR` | `./data` | SQLite file + photo files. Back this up. |
| `RETENTION_DAYS` | `90` | Trips are deleted this long after their last upload (owner can extend up to 365 days). |
| `RATE_LIMIT_PER_MIN` | `240` | Requests per IP per minute before 429. |
| `LOG` | on | `LOG=off` silences the JSON request log on stdout. |
| `TRIPLINK_BASE_URL` | request origin | Public URL used in share links, QR codes and join cards (set behind a proxy or short domain). |
| `PUSH_SUBJECT` | `mailto:admin@example.com` | VAPID contact sent to push services. Change it. |
| `PUSH_BATCH_MS` | 30 min | "N new photos" pushes are batched per trip into one notification per window. |
| `RECAP_AFTER_MS` | 48 h | Quiet period after the last upload before the recap notification. |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_REGION`, `S3_PATH_STYLE` | unset | Store files in S3 / R2 / MinIO instead of `DATA_DIR/photos` (SigV4, no SDK). `S3_PATH_STYLE=0` for virtual-host addressing. |

### Try it on your phone

Browsers only allow camera access on **HTTPS** (or `localhost`). For a quick phone test:

```bash
# any HTTPS tunnel works – e.g. cloudflared, ngrok, tailscale funnel
cloudflared tunnel --url http://localhost:8787
```

Open the printed `https://…` URL on your phone, create a trip, tap **Share**, and send the
link to a second phone.

### Deploy for a real trip

Any host that runs Node and gives you a persistent disk works. The simplest robust setup:

1. A small VPS (1 vCPU / 1 GB is plenty for a group of 30).
2. `DATA_DIR=/var/lib/triplink PORT=8787 node server.js` under systemd.
3. [Caddy](https://caddyserver.com/) in front for automatic HTTPS:
   ```
   photos.example.com {
     reverse_proxy localhost:8787
     request_body { max_size 30MB }
   }
   ```
4. Nightly `tar` of `/var/lib/triplink` to object storage.
5. A daily sweep so expired trips actually get deleted:
   ```
   # /etc/cron.d/triplink
   15 4 * * * triplink cd /opt/triplink && DATA_DIR=/var/lib/triplink node server.js --sweep >> /var/log/triplink-sweep.log 2>&1
   ```
6. Point your uptime monitor at `GET /api/health` (trip/photo counts, disk free, uptime).
7. Recap notifications ("all the photos are in", 48 h after the last upload) go out from cron too:
   ```
   0 * * * * triplink cd /opt/triplink && DATA_DIR=/var/lib/triplink node server.js --send-recaps >> /var/log/triplink-recaps.log 2>&1
   ```
   Set `PUSH_SUBJECT=mailto:you@example.com` so push services can reach you. VAPID keys are
   generated once into `DATA_DIR/vapid.json`; keep that file with your backups or every
   subscriber has to re-enable notifications.

The server logs one JSON line per request to stdout and shuts down cleanly on `SIGTERM`
(finishes in-flight requests, closes the database, exits within 10 s), so it behaves under
systemd, Docker and PaaS restarts.

Platform-as-a-service (Fly.io, Railway, Render) works too – attach a volume and point
`DATA_DIR` at it.

## How it works

```
phone camera ──▶ canvas (resize ≤2560px, JPEG) ──▶ IndexedDB queue ──▶ POST /api/trips/:code/photos
                                                   (survives offline)      └▶ POST …/:id/thumb
                                                                             ▼
                                                        data/photos/<trip>/<id>.jpg (+ .thumb.jpg)
                                                        data/triplink.db  (trips, members, photos)
```

* **Identity** – joining a trip returns a random member token stored in the phone's
  `localStorage`. There are no passwords or accounts. The trip creator is the *owner* and can
  delete any photo; members can delete their own.
* **Link = access** – anyone with the link/code can join, see and add photos. That matches how
  group trips actually work (the link is posted in the group chat) and is the main reason
  adoption is easy. See the spec for the stricter modes planned later.
* **Offline first** – captures are written to IndexedDB *before* uploading, then drained in
  order. Dead hotel Wi-Fi or airplane mode just delays the upload.
* **Images are checked by magic bytes**, capped at 25 MB, hashed (SHA-256) so the same photo is
  never stored twice in a trip, and kept under random UUID names. Rate limiting is per IP.
* **Retention** – a trip expires 90 days after its last upload (each upload extends it; the
  organiser can extend up to a year). `node server.js --sweep` deletes expired trips.
* **Organiser tools** – rename, trip dates, remove a member (with or without their photos),
  rotate the link (old link → "expired", existing members are forwarded), delete the trip.
* **Adoption loop** – QR code and printable A5 join card (`/t/<code>/card`, QR generated by
  `public/qr.js`, no external requests), one-tap WhatsApp / Telegram / SMS messages, a "who's
  missing" prompt for a lonely organiser, a "You added 0 · Priya 32" nudge in the gallery, and an
  iOS "Add to Home Screen" sheet shown once.
* **Notifications** – Web Push with VAPID and aes128gcm implemented in `push.js` on top of
  `node:crypto` only. Opt-in after the first upload; "N new photos from …" batched per trip;
  recap 48 h after the last upload via `node server.js --send-recaps`.
* **Media** – photos are resized on the phone (≤ 2560 px); with `sharp` installed the server
  also makes thumbnails, reads dimensions and converts HEIC/AVIF to JPEG. Videos up to 60 s /
  200 MB are recorded from a 1280 px canvas copy of the camera (H.264 on Safari, VP8 elsewhere)
  or imported, with a poster frame made on the phone. Files above 8 MB go through resumable
  chunked uploads that survive reloads. "Keep originals" stores the untouched file next to the
  resized copy and the ZIP then carries the originals. Wi-Fi-only and pause toggles hold uploads.
* **Storage backends** – local disk by default; S3-compatible object storage (AWS, R2, MinIO)
  with a hand-rolled SigV4 signer, selected by `S3_ENDPOINT`.

## API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/health` | – | Counts, disk free/total, uptime, push queue |
| GET | `/api/push/key` | – | VAPID public key for `PushManager.subscribe` |
| GET/POST/DELETE | `/api/trips/:code/push` | token | Notification status / subscribe `{subscription}` / unsubscribe `{endpoint}` |
| POST | `/api/trips` | – | Create trip → `{trip, member(token, isOwner)}` |
| GET | `/api/trips/:code` | – | Public info: name, dates, counts, `expiresAt`. `410` if the code was rotated |
| PATCH | `/api/trips/:code` | owner | `{name, startDate, endDate, extendDays \| expiresAt}` – rename, dates, extend retention |
| DELETE | `/api/trips/:code` | owner | Delete trip, members, photos and files |
| POST | `/api/trips/:code/rotate` | owner | New code; the old link answers `410` from now on |
| POST | `/api/trips/:code/join` | – | Join → member token |
| GET | `/api/trips/:code/me` | token | Validate token, get own role. Works with a retired code for existing members (returns the current code) |
| PATCH | `/api/trips/:code/me` | token | `{name}` – change own display name |
| GET | `/api/trips/:code/members` | token | Who is in, with photo counts |
| DELETE | `/api/trips/:code/members/:id[?deletePhotos=1]` | owner | Remove a member (token stops working); optionally delete their photos |
| GET | `/api/trips/:code/photos` | token | Newest-first photo list |
| POST | `/api/trips/:code/photos` | token | Upload original (raw body, `X-Photo-Meta` JSON header). `409` + existing photo if the same bytes are already in the trip |
| POST | `/api/trips/:code/photos/:id/thumb` | token (uploader) | Upload JPEG thumbnail / video poster |
| POST | `/api/trips/:code/photos/:id/original` | token (uploader) | Upload the untouched file (trip must keep originals, ≤ 60 MB) |
| GET | `/api/trips/:code/photos/:id/file` | – | Display file (`?download=1` for attachment) |
| GET | `/api/trips/:code/photos/:id/thumb` | – | Thumbnail / poster |
| GET | `/api/trips/:code/photos/:id/original` | – | Untouched original when kept |
| POST | `/api/trips/:code/uploads` | token | Start a resumable upload `{size, takenAt?, width?, height?, duration?}` → `{uploadId, chunkBytes}` |
| GET / PUT / DELETE | `/api/trips/:code/uploads/:id` | token | Status `{received}` / append a chunk at `?offset=` (409 + `received` if out of order) / abort |
| POST | `/api/trips/:code/uploads/:id/complete` | token | Assemble and store (same result as a direct upload) |
| DELETE | `/api/trips/:code/photos/:id` | token (uploader/owner) | Delete photo |
| GET | `/api/trips/:code/download.zip` | token | Stream every photo as a ZIP |

Auth is the `X-Member-Token` header (or `Authorization: Bearer …`).

## What is deliberately not here yet

Face/person grouping, native app wrappers, access modes beyond "link = access". All of these are scoped in
`docs/PRODUCT_SPEC.md` with the reasoning and the order to build them in.
