# Adoption Playbook – how to make sure *everyone* on the trip uses it

The honest answer to "how do I make sure everyone downloads it" is: **design it so nobody has
to download anything to join, and make the one person who cares (the organiser) able to pull
everyone else in.** Then use the product itself to nudge the stragglers. In that order.

## 1. Remove the download from the join path

* **The link is the app.** Tapping the link opens the camera in the browser. There is nothing to
  install before the first photo is taken. Every step you add before "first photo" loses ~20–30 %
  of a group.
* **No accounts.** Ask for a first name only. OTP/email sign-up is the biggest drop-off in
  consumer apps; a trip album does not need it.
* **Install comes *after* value.** Prompt "Add to home screen" only after someone has uploaded
  their first photo or opened the gallery twice. At that point they know why they want the icon.
* **Keep both paths alive.** Even when a store app exists, the web link must remain fully
  functional: the person who refuses to install still contributes and still receives the ZIP.

## 2. Make the organiser the distribution channel

Every trip has one person who cares. Give them tools, not a marketing budget.

* **Share sheet in one tap** → WhatsApp / Telegram / iMessage group that already exists.
* **A pre-written message**: "Join *Goa with the gang* and add your photos – opens in your
  browser, no sign-up: <link>". Pre-written text gets sent; a bare link gets ignored.
* **Short code read aloud** ("it's `j77jx6t8zm`") for the dinner-table moment when the chat is
  buried. v1: QR code on the share screen, and a printable A5 "scan to join" card for
  weddings/school trips.
* **Show who is *not* in.** The members list makes stragglers visible; v1 adds "invite the
  ones missing" with contact picker. Social pressure inside a friend group is the strongest
  adoption tool there is.

## 3. In-trip nudges that pull people in

* **Momentum is visible**: the join screen says "6 people · 84 photos so far". Nobody joins an
  empty room; everybody joins a full one.
* **First-photo prompt**: after joining, land directly on the camera, not on a menu.
* **Push (v1)**: "18 new photos from Priya and Arjun" – the notification *is* the reason to
  come back and add your own.
* **Reciprocity**: gallery shows "You've added 0 photos · Priya 32" – gentle, and it works.
* **Late joiners still count**: "Add from gallery" multi-select lets someone who ignored the
  link for three days dump their camera roll in one go.

## 4. The end-of-trip moment (this is where "everyone downloads" actually happens)

* **One button, one file.** "Download all" produces a single ZIP with sensible file names. No
  per-photo tapping, no third-party cloud account.
* **Retention deadline as a nudge**: "This trip's photos are kept until 12 Dec. Download all."
  Deadlines convert; a permanent album gets postponed forever.
* **Recap notification** two days after the last upload: "Goa with the gang: 412 photos from 9
  people. Get them all →".
* **Export to where they already live**: v1 adds "Save to Google Photos / iCloud" so people who
  will never open a ZIP still get everything.

## 5. Getting the *first* organisers (go-to-market)

You do not need everyone to know the product; you need one organiser per group.

| Channel | Why it works |
|---|---|
| **Friends' trips first** | Run five real trips. Fix what annoyed people. Screenshots of real albums are the marketing. |
| **Wedding photographers & planners** | They already promise "guest photos"; a branded link is a service they can resell. |
| **Schools, colleges, treks, cycling clubs, hackathons** | One coordinator, 30–200 participants, recurring events. |
| **Tour operators and hostels** | Printed QR in the bus / at reception; every group is a new trip. |
| **Travel communities** (Reddit r/travel, Indian travel Instagram, Telegram trip groups) | Post the ZIP-at-the-end story, not the feature list. |
| **App Store / Play Store listing (v1, TWA wrapper)** | Mostly for trust ("it's a real app") and the icon; the join path stays the web link. |

Landing page copy that converts: *"Everyone's trip photos. One link. No app to install."*
Then a 10-second video: tap link → shutter → photo appears on the other phone.

## 6. Measure the funnel and fix the leak

```
link sent → link opened → joined → first photo → returned next day → downloaded all
```
Track counts per trip (no personal analytics needed). The step with the biggest drop is the
next feature to build. Typical first findings: (a) people open on desktop where there is no
camera – add "open on your phone" QR; (b) iOS users lose the tab – push the home-screen
install harder on iOS; (c) nobody downloads – add the deadline and the recap.

## 7. Things that *sound* like adoption tactics but backfire

* Gating the gallery behind installing the app ("install to see photos"). People leave.
* Requiring a phone number "to protect the group". OTP fails on roaming; use approval mode instead.
* Auto-posting to social media. Trip photos are private by nature.
* Spamming the group chat from the app. One share message from the organiser, then let the
  photos do the talking.
