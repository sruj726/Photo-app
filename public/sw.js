/* TripLink service worker: offline app shell + cached thumbnails. */
const SHELL = 'triplink-shell-v4';
const MEDIA = 'triplink-media-v1';
const SHELL_FILES = ['/', '/app.js', '/gallery.js', '/qr.js', '/style.css', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png'];

// ---- Web Push: show the notification the server encrypted for us, open the trip on tap.
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { title: 'TripLink', body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(data.title || 'TripLink', {
    body: data.body || '', icon: '/icon-192.png', badge: '/icon-192.png', tag: data.tag || 'triplink', renotify: !!data.tag,
    data: { url: data.url || '/' },
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const existing = list.find((c) => 'focus' in c);
    if (existing) { existing.navigate(url); return existing.focus(); }
    return self.clients.openWindow(url);
  }));
});
const MEDIA_LIMIT = 600; // thumbnails/originals kept for offline browsing

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => ![SHELL, MEDIA].includes(k)).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

async function trimCache(name, limit) {
  const c = await caches.open(name);
  const keys = await c.keys();
  if (keys.length > limit) await Promise.all(keys.slice(0, keys.length - limit).map((k) => c.delete(k)));
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // Photo bytes are immutable per id: cache-first.
  if (/^\/api\/trips\/[^/]+\/photos\/[^/]+\/(thumb|file)$/.test(url.pathname) && !url.searchParams.has('download')) {
    e.respondWith((async () => {
      const c = await caches.open(MEDIA);
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      // Cache images only – videos are large and stream better straight from the server.
      if (res.ok && (res.headers.get('content-type') || '').startsWith('image/')) { c.put(req, res.clone()); trimCache(MEDIA, MEDIA_LIMIT); }
      return res;
    })());
    return;
  }
  if (url.pathname.startsWith('/api/')) return; // JSON API: network only

  // Navigations & shell: network-first, fall back to cached shell.
  e.respondWith((async () => {
    const c = await caches.open(SHELL);
    try {
      const res = await fetch(req);
      if (res.ok) c.put(req.mode === 'navigate' ? '/' : req, res.clone());
      return res;
    } catch {
      return (await c.match(req.mode === 'navigate' ? '/' : req)) || Response.error();
    }
  })());
});
