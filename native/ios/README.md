# TripLink for iOS – Capacitor wrapper with background uploads

The iOS app is a thin [Capacitor](https://capacitorjs.com) shell that loads the **live web app**
(`server.url` in `capacitor.config.json`) – the same HTML/JS the browser gets, so there is one
codebase and the join link keeps working for everyone who does not install anything.

What the shell adds that Safari cannot do:

1. **Background uploads.** The `TripLinkNative` plugin (`ios-plugin/`) takes each queued photo or
   video from the web app and uploads it with a *background* `URLSession`, so transfers continue
   after the phone is locked or the app is swiped away. The web app already has the hook: when
   `window.TripLinkNative.enqueueUpload` exists, `app.js` hands items over and waits for the
   `triplink:native-upload-done` / `triplink:native-upload-failed` events instead of uploading itself.
2. **Universal Links.** `https://<host>/t/<code>` opens the app when installed (served by the
   server at `/.well-known/apple-app-site-association` when `IOS_APP_ID` is set).
3. An App Store listing, icon and full-screen launch.

> Not compiled in CI (no Xcode in the test environment). The Swift plugin follows the Capacitor
> 6 plugin API; treat it as the starting point for the Xcode project, not a finished binary.

## Setup

```bash
cd native/ios
npm install                              # @capacitor/core, @capacitor/cli, @capacitor/ios
# edit capacitor.config.json: appId, appName, server.url = your TRIPLINK_BASE_URL
npx cap add ios
# copy ios-plugin/TripLinkNative.swift + TripLinkNative.m into ios/App/App/ (add to the target)
npx cap open ios
```

In Xcode:

- Signing & Capabilities → **Associated Domains**: `applinks:photos.example.com`.
- Background Modes → **Background fetch** and **Background processing** (URLSession background
  transfers work without these, but they let the completion handler run promptly).
- Set `IOS_APP_ID=<TEAMID>.<bundle id>` on the server so `/.well-known/apple-app-site-association`
  is served (must be `application/json`, no redirect, HTTPS).

## How the upload bridge works

```
web app (app.js)                     TripLinkNative.swift
  qAdd(item) ─▶ syncQueue()            
  nativeBridge().enqueueUpload({       writes blob to Application Support/uploads/<queueId>
     queueId, url, token, blob,        creates URLSession(background:) uploadTask(with: request,
     thumb, original, meta })          fromFile:) with X-Member-Token + X-Photo-Meta headers
                                       on completion: POST thumb / original if provided
  ◀── 'triplink:native-upload-done'    notifyListeners → JS dispatches CustomEvent with {queueId, photo}
  qDel(queueId)
```

The web side marks the item `nativeHandoff: true` so it is not uploaded twice, and clears the
flag when the native side reports a retryable failure (then the normal web upload takes over).

## App Store checklist

- [ ] App name "TripLink", subtitle *Everyone's trip photos, one link*.
- [ ] Privacy nutrition labels: Photos/Videos (user content, linked to a display name only),
      Coarse location only when the trip's map feature is on. No tracking.
- [ ] Camera + Photo Library usage strings in `Info.plist` (the web view asks via WKWebView).
- [ ] Review notes: explain that the app is a wrapper around the web app and that the *same*
      features are available on the web (Guideline 4.2 – make sure native adds real value:
      background uploads, universal links, share extension).
- [ ] Share extension (optional): forwards shared photos to `/share-target` in the web view.
- [ ] TestFlight with a real trip: lock the phone mid-upload and confirm the photos land.
