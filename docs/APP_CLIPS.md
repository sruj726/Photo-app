# App Clips (iOS) and Instant Apps (Android) – feasibility

**Question:** would an App Clip / Instant App remove a step from joining a trip?

**Answer: no – the web link already *is* the zero-install path, so neither is worth building now.**

| | App Clip (iOS) | Instant App (Android) | The web link (what we have) |
|---|---|---|---|
| Triggered by | NFC tag, QR (App Clip Code), Safari banner, Messages link | Play "Try now", deep link | Any link, any QR |
| Size limit | 10 MB (15 MB on iOS 16+) | 15 MB (up to 4 MB per feature module) | n/a – ~120 KB of JS |
| Camera access | Yes | Yes | Yes (HTTPS) |
| Background upload | Limited (clip lifetime is short) | Limited | No (the shell adds it) |
| Persistence | Cleared after ~30 days unless upgraded to the full app | Cleared when memory is needed | localStorage/IndexedDB, survives as long as browser data |
| Push notifications | Ephemeral notifications only for 8 h | Limited | Web Push (Android; iOS 16.4+ when installed to Home Screen) |
| Build cost | Separate Xcode target, App Store review, Apple Developer account | Separate feature module, Play review | none |
| Steps to first photo | Scan/tap → clip card → *Open* → camera permission → shoot | Tap → "Try now" → load → permission → shoot | Tap → name → camera permission → shoot |

Observations:

1. **An App Clip adds a screen, not removes one.** Apple's clip card ("Open") sits between the
   link and the app; the web join screen is the same single step.
2. **Both are ephemeral.** The clip's local storage is wiped after inactivity, so the member token
   would be lost – exactly the failure mode the link + `localStorage` design avoids.
3. **Where a clip *would* win**: scanning an **App Clip Code** printed on the join card opens the
   camera in a native surface without a browser chrome, and Apple shows the *full app* banner after
   first use. That is a marketing nicety, not a reduction in steps.
4. **Instant Apps** are effectively deprecated in favour of Play Feature Delivery + "Try now",
   which is already served by the TWA (the installed app is small and the web app is the content).

**Decision:** skip both. Revisit an App Clip only if data shows iPhone users drop off at the
Safari join screen but complete it inside the full app – then the clip is a bridge to the App
Store listing, and its only job is to open `https://<host>/t/<code>` in a `WKWebView`.

Cost if we ever do it: ~2 weeks (clip target, invocation URL handling, App Clip Code artwork on
the printable card, review), plus the Apple Developer Program membership.
