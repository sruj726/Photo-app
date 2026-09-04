# TripLink for Android – Trusted Web Activity

A Trusted Web Activity (TWA) wraps the live web app in a full-screen Chrome tab with no browser
UI, publishable on Google Play. The web app stays the single source of truth: **the join link is
still the way in**; the store listing only adds an icon, trust and OS-level share/deep-link
integration.

> This project is *not* compiled in CI (no Android SDK in the test environment). It follows the
> stock `android-browser-helper` template and builds with Android Studio / `./gradlew`.

## Files

```
settings.gradle, build.gradle          root Gradle config
app/build.gradle                       depends on com.google.androidbrowserhelper:androidbrowserhelper
app/src/main/AndroidManifest.xml       LauncherActivity (TWA) + App Links intent filter for /t/*
app/src/main/res/values/strings.xml    asset statements + app name
app/src/main/res/mipmap-xxxhdpi/       launcher icon (from public/icon-512.png; add the other densities)
```

## One-time setup

1. **Host name.** Replace `photos.example.com` in `AndroidManifest.xml` and `strings.xml` with
   your `TRIPLINK_BASE_URL` host. Replace the package name `app.triplink.twa` if you like.
2. **Signing key.** Create a release keystore (`keytool -genkey -v -keystore triplink.jks
   -alias triplink -keyalg RSA -keysize 2048 -validity 10000`). Play App Signing will use its own
   key too: collect **both** SHA-256 fingerprints (Play Console → Setup → App integrity).
3. **Digital Asset Links.** Run the server with
   `ANDROID_PACKAGE=app.triplink.twa ANDROID_SHA256_FINGERPRINTS=AA:BB:…,CC:DD:…` and check
   `https://<host>/.well-known/assetlinks.json` returns the statement. Without a valid statement
   Chrome shows the URL bar (the app still works, it just looks like a browser).
4. **Build.** `./gradlew assembleRelease` (or Android Studio → Build → Generate Signed Bundle).
5. **Deep links.** `adb shell am start -a android.intent.action.VIEW -d "https://<host>/t/abc123"`
   must open the app, not the browser. If it opens the browser: fingerprints or host mismatch.

## Release checklist (Play Console)

- [ ] App name "TripLink", short description: *Everyone's trip photos. One link. No sign-up.*
- [ ] Screenshots: join screen, camera, gallery, share/QR (phone 1080×1920; take them from the PWA).
- [ ] Feature graphic 1024×500 with the camera-link icon.
- [ ] Privacy policy URL (host `/privacy` – add a static page describing: name + photos only,
      retention, deletion, no third-party SDKs, Web Push opt-in).
- [ ] Data safety form: photos/videos (user-provided, shared with trip members), approximate
      location only if the map feature is enabled per trip, no advertising, no selling.
- [ ] Content rating questionnaire (user-generated content → "moderation" answer: organisers
      can delete, members can report).
- [ ] Target API level current; `minSdk 21`.
- [ ] Internal testing track first; verify App Links from a Play-installed build (Play signing key).
- [ ] Store listing links to the web app for people who do not want to install anything.

## Share target on Android

The PWA manifest declares a `share_target`, so once installed (TWA or "Add to Home Screen"),
"Share → TripLink" from the system gallery sends photos/videos straight into the upload queue of
the last opened trip. Nothing extra is needed in this project.
