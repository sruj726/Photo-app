# TripLink – Product Specification

*Every aspect of "a camera app where a trip group's photos all land behind one link".*

---

## 1. The problem, precisely

After a group trip, photos are scattered across 8 phones. Getting them together today means:

* someone creating a WhatsApp/Telegram group and everyone dumping compressed, out-of-order
  photos into it (quality lost, no way to bulk download, 400 messages of noise), or
* a Google Photos / iCloud shared album, which needs everyone to have the same ecosystem, an
  account, an install, and to remember to add photos *afterwards* – which most people never do.

The friction is not storage, it is **collection**: photos are taken in a camera app that has no
idea a trip is happening. The fix is to put the *trip* in front of the *camera*: you open the
trip, you shoot, and the photo is already shared.

**One-line pitch:** *Open the link, take the photo, everyone already has it.*

## 2. Who it is for (personas)

| Persona | What they want | What they will not do |
|---|---|---|
| **The organiser** (creates the trip) | Everything in one place, easy hand-out at the end | Chase people individually for photos |
| **The casual member** (8 of 10 people) | Zero effort, see the good photos, get them all at the end | Sign up, install anything they will use once, read instructions |
| **The photographer of the group** | Keep full quality, get credit, not be the only one sharing | Upload 600 photos one by one |
| **The late joiner / kid / grandparent** | Just see the photos | Anything technical |

Secondary segments with identical mechanics: weddings, school trips, hackathons, bachelor
parties, team offsites, treks and rides, family reunions, tour operators' groups.

## 3. Core user flows

### 3.1 Create a trip (organiser, 20 seconds)
1. Open the app → *Start a trip* → type trip name and own name.
2. Land on **Share**: link `https://…/t/<code>`, a *Share* button (Web Share sheet → WhatsApp),
   and the short code to read aloud.
3. Post the link in the group chat that already exists for the trip.

### 3.2 Join (member, 10 seconds)
1. Tap the link → sees trip name and "*n* people, *m* photos so far".
2. Type name → *Join & open camera*. No email, no password, no OTP.
3. Optional: "Add to Home Screen" prompt so it behaves like an app (own icon, full screen).

### 3.3 Capture
* Big shutter, front/back flip, last-shot thumbnail, and *Add from gallery* for photos taken
  with the native camera or by someone who joined late.
* Capture → resize to ≤2560 px JPEG → written to an on-device queue → uploaded when there is
  signal. Status line shows "Offline, 3 saved, will upload later".

### 3.4 Browse
* Grid, newest first, name badge on each tile, tap for full-screen with name, time, size.
* Save one photo, delete your own (owner can delete any), swipe older/newer.

### 3.5 Get everything at the end
* **Download all** → one ZIP, files named `2026-03-14T18-22-05_Priya_1a2b3c4d.jpg`, so they
  sort chronologically across phones and you know who took what.

### 3.6 After the trip
* Link keeps working (retention policy decides for how long – §7.5).
* Organiser can delete the whole trip; photos are gone from the server.

## 4. Feature map

| Area | MVP (built) | v1 (next 4–6 weeks) | Later |
|---|---|---|---|
| Trip | create, share link, code entry, members list, **rename, dates, delete (Phase 1)** | cover photo, multiple organisers | archive, per-trip theme |
| Access | link = join; per-device token; owner role; remove member, rotate link, retention + sweep; **approval mode, PIN, co-organisers, reports, school preset, branding (Phase 5)** | – | SSO for organisations |
| Camera | live view, flip, shutter, gallery import, resize, **video ≤60 s (Phase 3)** | tap-to-focus/zoom, burst, grid overlay | live photos, RAW passthrough |
| Upload | offline queue, retry, thumbnail, magic-byte check, dedupe by SHA-256, **Wi-Fi-only + pause, HEIC/AVIF → JPEG (sharp), resumable chunked uploads, keep originals (Phase 3)** | background sync (Web Background Sync / native) | – |
| Gallery | grid, lightbox, per-photo save, delete, **day sections, filters, favourites/hearts, comments, gestures, virtualised grid (Phase 4)** | – | face-based "photos of me", best-shot picks, map view from GPS |
| Download | ZIP of everything, **ZIP of favourites, save-to-folder, Google Photos / iCloud steps (Phase 4)** | ZIP by person/day, "only photos I'm in" | print book export |
| Notify | **Web Push: batched "N new photos", 48 h recap (Phase 2)** | – | daily recap |
| Platform | PWA (iOS Safari, Android Chrome) | Android TWA on Play Store, iOS App Store wrapper (Capacitor) | desktop uploader |
| Ops | SQLite + disk, rate limit, health endpoint, JSON request log, graceful shutdown, **S3/R2 storage backend (Phase 3)** | CDN, backups, metrics, error tracking | multi-region |

## 5. Architecture

```
┌────────────┐  HTTPS   ┌─────────────────┐        ┌───────────────┐
│  PWA       │ ───────▶ │  Node API       │ ─────▶ │ SQLite (meta) │
│  camera    │          │  server.js      │        └───────────────┘
│  IndexedDB │ ◀─────── │  zip streaming  │ ─────▶ ┌───────────────┐
│  SW cache  │          └─────────────────┘        │ disk / S3     │
└────────────┘                                     └───────────────┘
```

**Why a PWA first and not a native app:** the whole adoption problem is "not everyone installs
the app". A link that *is* the app removes the problem. Native wrappers come later for the
store listing and for background upload on iOS, but the web version stays the join path.

**Why zero dependencies in the MVP:** it runs anywhere Node runs, has no supply-chain surface,
and can be handed to anyone to self-host for their own trip.

### 5.1 Data model

```
trips    (id, code UNIQUE, name, owner_member_id, created_at)
members  (id, trip_id, name, token UNIQUE, joined_at)
photos   (id, trip_id, member_id, mime, ext, size, width, height, taken_at, created_at, has_thumb)
```
Files: `photos/<trip_id>/<photo_id>.<ext>` and `<photo_id>.thumb.jpg`. Random UUIDs mean a URL
cannot be guessed and file names never collide.

### 5.2 Scaling path
* 1 VPS + disk: fine to ~10k photos/day.
* Then: originals to S3-compatible storage (Cloudflare R2 has no egress fees – important
  because "download all" is egress-heavy), thumbnails generated server-side with `sharp`,
  SQLite → Postgres when there is more than one API instance, ZIPs built by a worker and
  served from storage with a pre-signed URL.

## 6. Non-functional aspects

| Aspect | Decision |
|---|---|
| **Image size** | Client re-encodes to ≤2560 px JPEG q0.9 (~1–2 MB). "Keep original" toggle in v1 for photographers. |
| **Data usage** | Wi-Fi-only upload toggle (v1); thumbnails are 480 px (~30 KB) so browsing on roaming data is cheap. |
| **Battery** | Camera stream stops when the tab is hidden; no polling when hidden. |
| **Offline** | Queue in IndexedDB, app shell in service worker, thumbnails cached. |
| **Performance** | Grid uses lazy images; API responses are small JSON; ZIP is streamed, not buffered. |
| **Accessibility** | Buttons have labels, contrast ≥ 4.5:1, works with keyboard, `aria-live` on the app root. |
| **i18n** | Strings are inline in the MVP; extract to a dictionary in v1 (Hindi, Telugu, Spanish first). |
| **Browser support** | iOS Safari 15+, Android Chrome 90+, desktop Chrome/Firefox/Safari. HEIC decoding falls back to raw upload. |

## 7. Privacy, safety and legal

7.1 **Data collected**: display name, photos, upload timestamps, IP for rate limiting. Nothing
else. No analytics SDK in the MVP.

7.2 **EXIF**: re-encoding through canvas strips EXIF (including GPS) by default – a privacy win.
v1 offers "keep location for the map view" as an opt-in per trip.

7.3 **Access model**: link = access. State it plainly on the join screen. Mitigations: long
random codes (10 chars from a 31-symbol alphabet ≈ 2⁴⁹), link rotation (built: old link answers
"expired", members already in are forwarded to the new code, outsiders are not), removing
members (built), and optional join approval (Phase 5).

7.4 **Content**: the owner can delete anything; every member can delete their own; a *report*
button (v1) hides a photo pending owner review. Trips are private groups, so no public feed and
no discovery – this keeps moderation load near zero.

7.5 **Retention** (built in Phase 1): keep 90 days after the last upload (`RETENTION_DAYS`),
every upload pushes the date out, the organiser can extend in 90-day steps up to a year or delete
early. "Photos are kept until <date>" is shown on the Photos and Share tabs. A daily
`node server.js --sweep` deletes expired trips and their files. Warning by push/email at 75 days
comes with notifications in Phase 2.

7.6 **Minors**: school trips are a target segment. Only a first name is asked; no accounts; no
public visibility; the teacher (owner) controls deletion. **School mode (built)**: join approval,
first-name wording, comments off, 30-day retention, one tap in trip settings.

7.7 **Regulations**: GDPR/DPDP-style requirements are satisfied by: minimal data, deletion on
request (delete photo/trip), export (ZIP), and a short privacy page. Host in-region if the
audience is EU.

7.8 **Abuse**: magic-byte sniffing, size caps, per-IP rate limits, no HTML served from user
content, random file names, `X-Content-Type-Options: nosniff`. Add virus scanning only if
non-image uploads are ever allowed.

## 8. Cost model (order of magnitude)

Assume 10 people × 60 photos × 1.5 MB = **0.9 GB per trip**.

| Item | Cost |
|---|---|
| Storage (R2/S3 class) | ~$0.015 / GB-month → ~1.4¢ per trip-month |
| Egress for "download all" by 10 people | 9 GB → free on R2, ~$0.8 on S3 |
| Compute | one small VPS ($5–6/mo) handles hundreds of trips |

A trip costs cents. Monetisation options that fit the product: free for trips up to *n*
photos / 30 days; **Pro trip** (one-off ₹/$ per trip: unlimited, originals, 1-year retention,
printed book); B2B for tour operators, schools, wedding photographers (branded link, bulk).

## 9. Risks and how to defuse them

| Risk | Mitigation |
|---|---|
| People keep using the native camera | "Add from gallery" import, multi-select; v1 auto-import of photos taken during trip dates (native app) |
| iOS kills background uploads | Queue persists; resume on next open; native wrapper for true background upload |
| Link leaks outside the group | Long codes, approval mode, link rotation, retention window |
| Storage cost from video | Cap video length and resolution; Pro tier for more |
| "Yet another app" fatigue | It is a link, not an app; install prompt only after first successful upload |
| Camera quality worse than native | Use max resolution constraints; offer *system camera* import path; keep originals option |

## 10. Roadmap

1. **Week 0 (done)**: trip, link, camera, queue, gallery, ZIP, PWA. Run a real trip with it.
   **Phase 1 (done)**: trip settings, delete, member removal, link rotation, dedupe, retention
   + sweep, health/logging/shutdown, browser smoke test.
   **Phase 2 (done)**: QR + join card, share messages, who's-missing prompt, Web Push with
   recaps, reciprocity nudge, iOS install sheet.
   **Phase 3 (done)**: storage backends, sharp thumbnails + conversion, originals, video,
   chunked uploads, Wi-Fi/pause toggles. Decision: video posters are made on the phone (no
   ffmpeg on the server); recording uses a 1280 px canvas copy so phones can keep up.
   **Phase 4 (done)**: day sections, filters, hearts, comments, gestures, virtualised grid, export sheet.
   **Phase 5 (done)**: approval mode, PIN, co-organisers, reports, school preset, branding.
2. **Next**: Phase 6 native wrappers.
3. **Weeks 3–6**: join approval, expiring links, video, favourites/reactions, daily recap, TWA on
   Play Store.
4. **Later**: face grouping ("photos of me") on-device or with a vision model (this repo's YOLO
   work is a natural seed for person detection), best-shot selection, map view, print export.

## 11. Success metrics

* **Join rate**: members joined ÷ people in the group chat (target > 80 %).
* **Contribution rate**: members with ≥1 photo ÷ joined (target > 60 %).
* **Time-to-first-photo** after join (target < 60 s).
* **Download-all rate** at trip end (target > 50 % of members).
* **Trips created by a previous member** (the organic loop that matters most).
