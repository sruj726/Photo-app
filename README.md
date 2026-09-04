# Photo-app (TripLink) – one link for every photo from the trip

A camera app for groups on a trip. The organiser creates a **trip**, gets **one link**, and
everyone who opens the link becomes part of that trip. Every photo anyone takes through the
app (or adds from their gallery) lands in the same album. At the end, anyone taps
**Download all** and gets a single `.zip` with every photo from every phone.

No sign-up, no app store, no build step, no npm dependencies.

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
npm test                  # API tests
```

Requires Node **22.13+** (for `node:sqlite`). Photos and the database are written to `./data`
(override with `DATA_DIR=/somewhere`). Port with `PORT=…`.

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
* **Images are checked by magic bytes**, capped at 25 MB, and stored under random UUID names.
  Rate limiting is per IP.

## API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/trips` | – | Create trip → `{trip, member(token, isOwner)}` |
| GET | `/api/trips/:code` | – | Public info: name, member & photo counts |
| POST | `/api/trips/:code/join` | – | Join → member token |
| GET | `/api/trips/:code/me` | token | Validate token, get own role |
| GET | `/api/trips/:code/members` | token | Who is in, with photo counts |
| GET | `/api/trips/:code/photos` | token | Newest-first photo list |
| POST | `/api/trips/:code/photos` | token | Upload original (raw body, `X-Photo-Meta` JSON header) |
| POST | `/api/trips/:code/photos/:id/thumb` | token (uploader) | Upload JPEG thumbnail |
| GET | `/api/trips/:code/photos/:id/file` | – | Original (`?download=1` for attachment) |
| GET | `/api/trips/:code/photos/:id/thumb` | – | Thumbnail |
| DELETE | `/api/trips/:code/photos/:id` | token (uploader/owner) | Delete photo |
| GET | `/api/trips/:code/download.zip` | token | Stream every photo as a ZIP |

Auth is the `X-Member-Token` header (or `Authorization: Bearer …`).

## What is deliberately not here yet

Push notifications, QR code on the share screen, face/person grouping, video, expiry and
auto-delete, S3 storage, native app wrappers. All of these are scoped in
`docs/PRODUCT_SPEC.md` with the reasoning and the order to build them in.
