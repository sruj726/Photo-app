# Claude Code build plan and prompts

Run Claude Code at the root of this repository (`git clone https://github.com/sruj726/Photo-app`,
`cd Photo-app`, `claude`). It picks up `CLAUDE.md` automatically. Paste the **kickoff prompt** first, then one **phase prompt** at a
time. Each phase is sized to be one session and one commit series.

---

## Kickoff prompt (paste once)

```
You are building TripLink completely. Read CLAUDE.md, docs/PRODUCT_SPEC.md and
docs/ADOPTION_PLAYBOOK.md fully before doing anything. Then run `node server.js` and
`npm test` to confirm the current prototype works, and write test/ui.smoke.js: a Playwright
script (Chromium with --use-fake-device-for-media-stream and --use-fake-ui-for-media-stream)
that creates a trip, takes two photos with the shutter, imports a file, opens the gallery and
lightbox, joins as a second user in a new context, and downloads the ZIP. It must exit
non-zero on any page error or console error. Add it as `npm run smoke`.

Working rules for the whole project:
- Work phase by phase from docs/CLAUDE_CODE_PROMPT.md. Finish a phase completely (code,
  tests, docs) before starting the next. Commit per feature with the phase name.
- Never break the "link works without installing anything" rule or the offline queue.
- Before each commit run `npm test` and `npm run smoke`. If either fails, fix it first.
- When a decision is not covered by the spec, choose the option that needs fewer steps from
  the traveler, state the choice in the commit message, and add a line to the spec.
- Keep a running CHANGELOG.md with one line per shipped feature.
Confirm the baseline is green, then start Phase 1.
```

---

## Phase 1 – Make it trustworthy for a real trip

```
Phase 1. Implement, in this order, each with tests:
1. Trip management: DELETE /api/trips/:code (owner only) removing DB rows and files; PATCH
   /api/trips/:code to rename and set optional start/end dates; a "Trip settings" section on
   the Share tab for the owner with rename, dates and a two-step delete.
2. Member management: owner can remove a member (their token stops working; their photos stay
   unless the owner also ticks "delete their photos"). Members can change their own name.
3. Link rotation: owner can regenerate the trip code; old links show "this link has expired,
   ask the organiser for the new one".
4. Duplicate protection: compute SHA-256 of the uploaded bytes on the server and reject an
   identical file already in the trip with 409; the client treats 409 as success.
5. Retention: trips store `expires_at` (default 90 days after last upload, extended on every
   upload). A `node server.js --sweep` mode deletes expired trips; document a daily cron.
   Show "Photos are kept until <date>" on Share and Photos tabs.
6. Health and ops: /api/health returns photo count, disk usage of DATA_DIR and uptime;
   structured request logging to stdout; graceful shutdown on SIGTERM.
Update README API table and the spec. Commit per item.
```

## Phase 2 – Adoption features

```
Phase 2. Build the adoption loop from docs/ADOPTION_PLAYBOOK.md:
1. QR code on the Share tab, generated client-side with no external requests (write a small
   QR encoder module in public/qr.js, byte mode, error-correction M, versions 1-10; add a unit
   test that decodes a known payload by checking the module's own matrix against a fixture).
   Add a "Print join card" view: A5 page with trip name, QR and the code in large type.
2. Pre-written share message per platform (WhatsApp, Telegram, SMS, copy) with the trip name.
3. "Who's missing" prompt for the owner after 24h with fewer than N members: shows the share
   sheet again.
4. Web Push notifications (VAPID, no third-party service): opt-in banner after first upload;
   server sends "N new photos from <names>" batched at most once per 30 min per trip, and an
   end-of-trip recap 48h after the last upload. Store subscriptions per member. Add a
   `--send-recaps` server mode for cron.
5. Reciprocity nudge on the Photos tab: "You added 0 · Priya 32" line, with a one-tap jump to
   the camera.
6. iOS-specific install guidance: detect Safari, show an illustrated 2-step "Add to Home
   Screen" sheet the first time the gallery is opened, never again once dismissed.
Tests for every route; extend smoke for QR presence and the push opt-in banner.
```

## Phase 3 – Media quality and volume

```
Phase 3. Media pipeline:
1. "Keep originals" per-trip setting (owner). When on, the client uploads the untouched file
   as well as the 2560px version; the ZIP contains originals.
2. Server-side thumbnails and HEIC→JPEG conversion using `sharp` (this is the first allowed
   dependency; add package-lock and document the native build requirement). Client thumbnail
   upload becomes optional.
3. Video: capture up to 60 seconds with MediaRecorder (webm/mp4 depending on browser) and
   import from gallery; cap at 200 MB; poster frame generated server-side; playback in the
   lightbox.
4. Resumable uploads: chunked upload endpoints (init / PUT chunk / complete) for files above
   8 MB so a video survives a network drop; the queue records the upload id and resumes.
5. Wi-Fi-only upload toggle using the Network Information API where available; otherwise a
   manual "pause uploads" switch.
6. Storage backend abstraction: `storage/local.js` and `storage/s3.js` with the same interface;
   S3 selected by env vars; ZIP streaming reads from either. Add an integration test that runs
   against a local MinIO if `S3_ENDPOINT` is set, otherwise skips.
```

## Phase 4 – Browsing and organising

```
Phase 4. Gallery features:
1. Day sections with sticky headers, and a "by person" filter chip row.
2. Favourites (per member) and reactions (heart only) with counts; "Download favourites" ZIP.
3. Comments per photo, 280 chars, offline-queued.
4. Lightbox swipe gestures, pinch zoom, keyboard navigation, preloading of neighbours.
5. Virtualised grid so 3,000 photos scroll smoothly on a mid-range phone.
6. Export to Google Photos and iCloud: for now, per-platform instructions plus a "select all ·
   save" flow using the File System Access API where available.
```

## Phase 5 – Access modes and organisations

```
Phase 5. Access control beyond "link = access":
1. Join approval mode: joiners wait in a "pending" state; owner approves from the members list;
   pending members see a waiting screen that auto-refreshes.
2. PIN mode: optional 4-digit PIN asked on join; rate-limited.
3. Multiple organisers (co-owners).
4. Report a photo: hides it for the reporter immediately, flags it for owners.
5. "School mode" preset: approval on, first names only, no comments, 30-day retention.
6. Branded trips for operators: logo and colour per trip, custom short domain support via a
   TRIPLINK_BASE_URL env var used in all share links.
```

## Phase 6 – Store presence and native capabilities

```
Phase 6. Native wrappers, keeping the web link as the join path:
1. Android: Trusted Web Activity project under native/android with Digital Asset Links, deep
   link handling for /t/<code>, and a release checklist for Play Console.
2. iOS: Capacitor project under native/ios wrapping the same public/ folder, with a native
   background-upload plugin that drains the IndexedDB queue via a shared file store, and
   universal links for /t/<code>.
3. Share target: register the PWA (and native apps) as a share target so photos from the
   system gallery can be "shared to TripLink".
4. App Clip / Instant App exploration: document feasibility and cost; implement only if it
   removes a join step.
```

## Phase 7 – Intelligence (optional)

```
Phase 7. On-device or server-side intelligence, each strictly opt-in per trip:
1. "Photos of me": face embeddings computed in the browser (WebGPU/WASM model), matched
   locally against a selfie the member takes; nothing about faces leaves the device.
2. Best-shot suggestions for near-duplicate bursts (sharpness + eyes-open heuristics).
3. Person detection using the YOLO model from the parent repo to auto-build a "group photos"
   filter (photos with ≥3 people).
4. Map view from opt-in GPS with clustering by day.
Document the privacy stance for each in the spec before writing code.
```

---

## Per-session reminder prompt

```
Continue TripLink. Re-read CLAUDE.md and the current phase in docs/CLAUDE_CODE_PROMPT.md,
check CHANGELOG.md for what is already done, run `npm test` and `npm run smoke` to confirm
the tree is green, then pick up the next unfinished item. Do not start a new phase until the
current one is complete and documented.
```
