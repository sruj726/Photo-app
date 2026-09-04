/* TripLink – front-end (vanilla JS, no build step).
 *
 * Screens
 *   /            Home: create a trip, open trips you already joined, paste a code
 *   /t/<code>    Join screen (first visit) or the trip itself (Camera | Photos | Share)
 *
 * Every capture goes into an IndexedDB queue first and is uploaded from there, so
 * photos survive dead hotel Wi-Fi, airplane mode and the tab being closed.
 */
(() => {
  'use strict';

  const $app = document.getElementById('app');
  const $toast = document.getElementById('toast');
  const LS_TRIPS = 'triplink:trips';       // { [code]: { token, memberId, name, tripName, isOwner, joinedAt } }
  const LS_NAME = 'triplink:displayName';
  const MAX_LONG_EDGE = 2560;              // originals are re-encoded to this size max (keeps uploads ~1–2 MB)
  const THUMB_EDGE = 480;
  const CHUNK_THRESHOLD = window.TRIPLINK_CHUNK_THRESHOLD || 8 * 1024 * 1024;   // above this, use the resumable chunked upload
  const MAX_VIDEO_SECONDS = 60;
  const LS_WIFI = 'triplink:wifiOnly';
  const LS_PAUSED = 'triplink:paused';

  // ------------------------------------------------------------------ utils
  const h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtBytes = (n) => n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
  const fmtTime = (ms) => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const fmtDate = (ms) => new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
  const fmtRange = (t) => (t.startDate ? `${fmtDate(`${t.startDate}T00:00:00`)}${t.endDate ? ` – ${fmtDate(`${t.endDate}T00:00:00`)}` : ''}` : '');
  const keptUntil = (t) => (t.expiresAt ? `Photos are kept until ${fmtDate(t.expiresAt)}` : '');
  let toastTimer;
  function toast(msg, isError = false) {
    $toast.textContent = msg;
    $toast.className = 'toast' + (isError ? ' error' : '');
    $toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $toast.hidden = true; }, isError ? 4200 : 2200);
  }
  function loadTrips() { try { return JSON.parse(localStorage.getItem(LS_TRIPS) || '{}'); } catch { return {}; } }
  function saveTrip(code, rec) { const all = loadTrips(); all[code] = { ...(all[code] || {}), ...rec }; localStorage.setItem(LS_TRIPS, JSON.stringify(all)); }
  function forgetTrip(code) { const all = loadTrips(); delete all[code]; localStorage.setItem(LS_TRIPS, JSON.stringify(all)); }
  const savedName = () => localStorage.getItem(LS_NAME) || '';

  async function api(method, url, { json, body, headers = {}, token } = {}) {
    const opts = { method, headers: { ...headers } };
    if (token) opts.headers['X-Member-Token'] = token;
    if (json !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(json); }
    if (body !== undefined) opts.body = body;
    const res = await fetch(url, opts);
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok) { const e = new Error((data && data.error) || `HTTP ${res.status}`); e.status = res.status; e.data = data; throw e; }
    return data;
  }

  // ------------------------------------------------------------ upload queue
  const QDB = 'triplink-queue';
  function openQueue() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open(QDB, 2);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('queue')) db.createObjectStore('queue', { keyPath: 'id', autoIncrement: true });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });   // shared with sw.js (share target)
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  async function metaSet(key, value) {
    const db = await openQueue();
    return new Promise((resolve, reject) => { const tx = db.transaction('meta', 'readwrite'); tx.objectStore('meta').put({ key, value }); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
  }
  async function qAll() {
    const db = await openQueue();
    return new Promise((resolve, reject) => {
      const r = db.transaction('queue').objectStore('queue').getAll();
      r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
    });
  }
  async function qAdd(item) {
    const db = await openQueue();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('queue', 'readwrite');
      const r = tx.objectStore('queue').add(item);
      r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
    });
  }
  async function qDel(id) {
    const db = await openQueue();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('queue', 'readwrite');
      tx.objectStore('queue').delete(id);
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
  }
  async function qPatch(id, patch) {
    const db = await openQueue();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('queue', 'readwrite');
      const store = tx.objectStore('queue');
      const r = store.get(id);
      r.onsuccess = () => { if (r.result) store.put({ ...r.result, ...patch }); };
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
  }

  let syncing = false;
  const syncListeners = new Set();
  function onSync(fn) { syncListeners.add(fn); return () => syncListeners.delete(fn); }
  function notifySync(ev) { for (const fn of syncListeners) fn(ev); }

  // ---- upload policy: manual pause, and "Wi-Fi only" where the browser tells us the connection type
  const isPaused = () => localStorage.getItem(LS_PAUSED) === '1';
  const wifiOnly = () => localStorage.getItem(LS_WIFI) === '1';
  const connectionType = () => (navigator.connection && navigator.connection.type) || 'unknown';
  function uploadBlocker() {
    if (isPaused()) return 'paused';
    if (wifiOnly()) {
      const t = connectionType();
      if (t !== 'unknown' && t !== 'wifi' && t !== 'ethernet') return 'wifi';
    }
    return null;
  }
  if (navigator.connection && navigator.connection.addEventListener) navigator.connection.addEventListener('change', () => syncQueue());

  /** Resumable chunked upload for large files. Remembers the upload id in the queue item so a reload resumes. */
  async function uploadChunked(item, rec, onProgress) {
    const base = `/api/trips/${item.code}/uploads`;
    let uploadId = item.uploadId || null;
    let received = 0;
    let chunkBytes = 4 * 1024 * 1024;
    if (uploadId) {
      try { const st = await api('GET', `${base}/${uploadId}`, { token: rec.token }); received = st.received; chunkBytes = st.chunkBytes || chunkBytes; }
      catch (err) { if (err.status && err.status < 500) uploadId = null; else throw err; }
    }
    if (!uploadId) {
      const init = await api('POST', base, { token: rec.token, json: { size: item.blob.size, takenAt: item.takenAt, width: item.width, height: item.height, duration: item.duration } });
      uploadId = init.uploadId; chunkBytes = init.chunkBytes || chunkBytes; received = 0;
      await qPatch(item.id, { uploadId });
    }
    while (received < item.blob.size) {
      const chunk = item.blob.slice(received, Math.min(item.blob.size, received + chunkBytes));
      try {
        const r = await api('PUT', `${base}/${uploadId}?offset=${received}`, { token: rec.token, body: chunk, headers: { 'Content-Type': 'application/octet-stream' } });
        received = r.received;
      } catch (err) {
        if (err.status === 409 && err.data && typeof err.data.received === 'number') { received = err.data.received; continue; }
        throw err;
      }
      if (onProgress) onProgress(received / item.blob.size);
    }
    return api('POST', `${base}/${uploadId}/complete`, { token: rec.token });
  }

  let syncAgain = false;
  // ---- Native wrapper bridge (Phase 6). The Capacitor plugin (native/ios) registers window.TripLinkNative with
  // enqueueUpload({queueId, url, token, blob, meta}) and fires 'triplink:native-upload-done' / '-failed' events.
  // Uploads keep going after the app is backgrounded on iOS, which a web page cannot do on its own.
  const nativeBridge = () => (window.TripLinkNative && typeof window.TripLinkNative.enqueueUpload === 'function' ? window.TripLinkNative : null);
  window.addEventListener('triplink:native-upload-done', async (e) => {
    const { queueId, photo } = e.detail || {};
    if (!queueId) return;
    await qDel(queueId).catch(() => {});
    notifySync({ type: 'done', item: { id: queueId }, photo });
  });
  window.addEventListener('triplink:native-upload-failed', async (e) => {
    const { queueId, permanent, error } = e.detail || {};
    if (!queueId) return;
    await qPatch(queueId, { nativeHandoff: false }).catch(() => {});
    if (permanent) { await qDel(queueId).catch(() => {}); notifySync({ type: 'failed', item: { id: queueId }, error }); }
    else notifySync({ type: 'offline', item: { id: queueId }, error });
  });

  async function syncQueue() {
    if (syncing) { syncAgain = true; return; }   // something was added mid-sync: run once more when done
    syncing = true;
    try {
      let stop = false;
      while (!stop) {
        const items = await qAll();
        if (!items.length) break;
        const blocker = uploadBlocker();
        if (blocker) { notifySync({ type: 'blocked', reason: blocker, remaining: items.length }); break; }
        for (const item of items) {
          const rec = loadTrips()[item.code];
          if (!rec) { await qDel(item.id); continue; }
          notifySync({ type: 'start', item, remaining: items.length });
          try {
            if (item.kind === 'comment') {
              // Queued while offline: post it now.
              const { comment } = await api('POST', `/api/trips/${item.code}/photos/${item.photoId}/comments`, { token: rec.token, json: { text: item.text } });
              await qDel(item.id);
              notifySync({ type: 'done', item, comment });
              continue;
            }
            const native = nativeBridge();
            if (native && item.kind !== 'comment' && !item.nativeHandoff) {
              // Hand the transfer to the native background uploader; completion comes back as an event.
              await qPatch(item.id, { nativeHandoff: true });
              await native.enqueueUpload({ queueId: item.id, url: `/api/trips/${item.code}/photos`, token: rec.token, blob: item.blob, thumb: item.thumb, original: item.original,
                meta: { takenAt: item.takenAt, width: item.width, height: item.height, duration: item.duration } });
              continue;
            }
            if (item.nativeHandoff) continue;   // already with the native uploader
            let result;
            if (item.blob.size > CHUNK_THRESHOLD) {
              result = await uploadChunked(item, rec, (frac) => notifySync({ type: 'progress', item, frac }));
            } else {
              const meta = JSON.stringify({ takenAt: item.takenAt, width: item.width, height: item.height, duration: item.duration });
              result = await api('POST', `/api/trips/${item.code}/photos`, {
                body: item.blob, token: rec.token, headers: { 'Content-Type': item.blob.type || 'application/octet-stream', 'X-Photo-Meta': meta },
              });
            }
            const { photo } = result;
            if (item.thumb && !photo.hasThumb) {
              try { await api('POST', `/api/trips/${item.code}/photos/${photo.id}/thumb`, { body: item.thumb, token: rec.token, headers: { 'Content-Type': 'image/jpeg' } }); }
              catch { /* thumbnail is optional */ }
            }
            if (item.original) {
              // Untouched file for trips that keep originals. Rejected (400) when the organiser turned it off meanwhile: fine.
              try { await api('POST', `/api/trips/${item.code}/photos/${photo.id}/original`, { body: item.original, token: rec.token, headers: { 'Content-Type': item.original.type || 'application/octet-stream' } }); }
              catch { /* optional */ }
            }
            await qDel(item.id);
            notifySync({ type: 'done', item, photo });
          } catch (err) {
            // 409 = these exact bytes are already in the trip. That is success from the traveler's point of view.
            if (err.status === 409) {
              await qDel(item.id);
              notifySync({ type: 'done', item, photo: err.data && err.data.photo, duplicate: true });
              continue;
            }
            // Permanent failures: drop the item so the queue can't wedge. Network errors: stop and retry later.
            if (err.status && err.status !== 429 && err.status < 500) {
              await qDel(item.id);
              notifySync({ type: 'failed', item, error: err.message });
              continue;
            }
            notifySync({ type: 'offline', item, error: err.message });
            stop = true;
            break;
          }
        }
      }
    } finally {
      syncing = false;
      notifySync({ type: 'idle' });
      if (syncAgain) { syncAgain = false; syncQueue(); }
    }
  }
  window.addEventListener('online', () => syncQueue());
  setInterval(async () => { if (navigator.onLine && (await qAll()).length) syncQueue(); }, 20000);

  // ------------------------------------------------------- image processing
  async function decode(blobOrFile) {
    if ('createImageBitmap' in window) {
      try { return await createImageBitmap(blobOrFile, { imageOrientation: 'from-image' }); }
      catch { /* fall through (e.g. HEIC on non-Safari) */ }
    }
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blobOrFile);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Cannot decode image')); };
      img.src = url;
    });
  }
  function drawScaled(src, maxEdge, quality) {
    const w = src.videoWidth || src.naturalWidth || src.width;
    const hgt = src.videoHeight || src.naturalHeight || src.height;
    const scale = Math.min(1, maxEdge / Math.max(w, hgt));
    const cw = Math.round(w * scale), ch = Math.round(hgt * scale);
    const canvas = document.createElement('canvas');
    canvas.width = cw; canvas.height = ch;
    canvas.getContext('2d').drawImage(src, 0, 0, cw, ch);
    return new Promise((resolve) => canvas.toBlob((b) => resolve({ blob: b, width: cw, height: ch }), 'image/jpeg', quality));
  }
  async function enqueueCapture(code, source, takenAt, original = null) {
    const full = await drawScaled(source, MAX_LONG_EDGE, 0.9);
    const thumb = await drawScaled(source, THUMB_EDGE, 0.7);
    await qAdd({ code, kind: 'photo', takenAt, width: full.width, height: full.height, blob: full.blob, thumb: thumb.blob, original, addedAt: Date.now() });
    syncQueue();
    return thumb.blob;
  }
  /** Poster frame + duration for a video blob, decoded by the browser's own <video>. */
  function videoPoster(blob) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
      const finish = async (ok) => {
        let thumb = null, width = v.videoWidth || null, height = v.videoHeight || null;
        if (ok && width && height) { try { thumb = (await drawScaled(v, THUMB_EDGE, 0.7)).blob; } catch { thumb = null; } }
        const duration = Number.isFinite(v.duration) ? v.duration : null;
        URL.revokeObjectURL(url);
        resolve({ thumb, width, height, duration });
      };
      v.onloadeddata = () => { try { v.currentTime = Math.min(0.5, (v.duration || 1) / 2); } catch { finish(true); } };
      v.onseeked = () => finish(true);
      v.onerror = () => finish(false);
      setTimeout(() => finish(!!v.videoWidth), 4000);
    });
  }
  async function enqueueVideo(code, blob, takenAt) {
    if (blob.size > 200 * 1024 * 1024) throw new Error('Video is over 200 MB');
    const meta = await videoPoster(blob);
    if (meta.duration && meta.duration > MAX_VIDEO_SECONDS + 1) throw new Error(`Videos are limited to ${MAX_VIDEO_SECONDS} seconds`);
    await qAdd({ code, kind: 'video', takenAt, width: meta.width, height: meta.height, duration: meta.duration, blob, thumb: meta.thumb, original: null, addedAt: Date.now() });
    syncQueue();
    return meta.thumb;
  }
  async function enqueueFile(code, file, keepOriginal = false) {
    const takenAt = file.lastModified || Date.now();
    if ((file.type || '').startsWith('video/')) return enqueueVideo(code, file, takenAt);
    try {
      const bmp = await decode(file);
      const t = await enqueueCapture(code, bmp, takenAt, keepOriginal ? file : null);
      if (bmp.close) bmp.close();
      return t;
    } catch {
      // Could not decode client-side (e.g. HEIC outside Safari): upload the raw file, the server converts it.
      await qAdd({ code, kind: 'photo', takenAt, width: null, height: null, blob: file, thumb: null, original: null, addedAt: Date.now() });
      syncQueue();
      return null;
    }
  }

  // ---------------------------------------------------------------- router
  function navigate(path) { history.pushState({}, '', path); render(); }
  window.addEventListener('popstate', render);
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-nav]');
    if (a) { e.preventDefault(); navigate(a.getAttribute('href')); }
  });

  let teardown = null;
  async function render() {
    if (teardown) { try { teardown(); } catch { /* ignore */ } teardown = null; }
    const card = location.pathname.match(/^\/t\/([a-z0-9]{6,16})\/card\/?$/i);
    if (card) return renderCard(card[1].toLowerCase());
    const m = location.pathname.match(/^\/t\/([a-z0-9]{6,16})\/?$/i);
    if (m) return renderTrip(m[1].toLowerCase());
    return renderHome();
  }

  // ------------------------------------------------------------ share helpers
  const tripLink = (code, trip) => `${(trip && trip.baseUrl) || location.origin}/t/${code}`;
  const qrSvg = (text, scale) => { try { return window.QR.toSvg(window.QR.encode(text), { scale, quiet: 2, dark: '#0f1115', light: '#ffffff' }); } catch { return ''; } };
  const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
  /** Per-trip branding: accent colour (with readable text colour) and logo. */
  function applyBrand(trip) {
    const root = document.documentElement;
    const color = trip && trip.brand && trip.brand.color;
    if (color && /^#[0-9a-f]{6}$/i.test(color)) {
      const r = parseInt(color.slice(1, 3), 16), g = parseInt(color.slice(3, 5), 16), b = parseInt(color.slice(5, 7), 16);
      const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      root.style.setProperty('--accent', color);
      root.style.setProperty('--accent-fg', lum > 0.6 ? '#1a1200' : '#ffffff');
    } else { root.style.removeProperty('--accent'); root.style.removeProperty('--accent-fg'); }
  }
  const brandLogo = (trip, cls = 'logo') => (trip && trip.brand && trip.brand.logoUrl ? `<img class="${cls}" src="${h(trip.brand.logoUrl)}" alt="">` : `<img class="${cls}" src="/icon.svg" alt="">`);
  const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  function shareMessage(trip, link) {
    return `Join "${trip.name}" on TripLink and add your photos – it opens in your browser, no sign-up: ${link}`;
  }
  async function shareLink(trip, link) {
    const text = shareMessage(trip, link);
    if (navigator.share) { try { await navigator.share({ title: trip.name, text, url: link }); return; } catch { /* cancelled */ } }
    await navigator.clipboard.writeText(text).catch(() => {});
    toast('Message copied – paste it in your group chat');
  }

  // --------------------------------------------------------- push notifications
  const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  function b64uToBytes(s) { const b = atob(s.replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(b, (c) => c.charCodeAt(0)); }
  async function subscribePush(code, rec) {
    if (!pushSupported()) throw new Error('Notifications are not supported in this browser');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('Notifications were not allowed');
    const reg = await navigator.serviceWorker.ready;
    const { publicKey } = await api('GET', '/api/push/key');
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(publicKey) });
    await api('POST', `/api/trips/${code}/push`, { token: rec.token, json: { subscription: sub.toJSON() } });
    localStorage.setItem(`triplink:push:${code}`, 'on');
  }
  async function unsubscribePush(code, rec) {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) await api('DELETE', `/api/trips/${code}/push`, { token: rec.token, json: { endpoint: sub.endpoint } });
    localStorage.setItem(`triplink:push:${code}`, 'off');
  }

  // --------------------------------------------------------------- join card
  async function renderCard(code) {
    $app.innerHTML = '<div class="loading">Preparing card…</div>';
    let trip;
    try { ({ trip } = await api('GET', `/api/trips/${code}`)); }
    catch (err) { $app.innerHTML = `<div class="screen"><div class="card"><h2>Trip not found</h2><p>${h(err.message)}</p><a class="btn" data-nav href="/">Go home</a></div></div>`; return; }
    const link = tripLink(code, trip);
    applyBrand(trip);
    document.title = `${trip.name} – join card`;
    $app.innerHTML = `
      <div class="join-card" id="join-card">
        <div class="join-card-inner">
          <div class="jc-kicker">Trip photos · TripLink</div>
          ${trip.brand && trip.brand.logoUrl ? `<img class="jc-logo" src="${h(trip.brand.logoUrl)}" alt="">` : ''}
          <h1>${h(trip.name)}</h1>
          ${fmtRange(trip) ? `<div class="jc-dates">${h(fmtRange(trip))}</div>` : ''}
          <div class="jc-qr">${qrSvg(link, 8)}</div>
          <div class="jc-scan">Scan to add your photos</div>
          <div class="jc-code">${h(code)}</div>
          <div class="jc-url">${h(link)}</div>
          <div class="jc-foot">Opens in your browser. No app, no sign-up. Everyone's photos, one album.</div>
        </div>
        <div class="jc-actions no-print">
          <button class="btn primary" id="print">🖨 Print (A5)</button>
          <a class="btn" data-nav href="/t/${h(code)}?tab=share">Back to trip</a>
        </div>
      </div>`;
    $app.querySelector('#print').onclick = () => window.print();
  }

  // ------------------------------------------------------------------ home
  function renderHome() {
    applyBrand(null);
    const sharedFlag = new URLSearchParams(location.search).get('shared');
    if (sharedFlag === 'no-trip') { toast('Open a trip first, then share photos to TripLink', true); history.replaceState({}, '', '/'); }
    else if (sharedFlag === 'error') { toast('Could not take the shared files', true); history.replaceState({}, '', '/'); }
    const trips = Object.entries(loadTrips()).sort((a, b) => (b[1].joinedAt || 0) - (a[1].joinedAt || 0));
    $app.innerHTML = `
      <div class="screen">
        <div class="hero">
          <img class="logo" src="/icon.svg" alt="">
          <h1>TripLink</h1>
          <p>One link. Every photo from the trip, from everyone, in one place. No sign-up.</p>
        </div>
        <form class="card" id="create">
          <h2>Start a trip</h2>
          <label for="tripName">Trip name</label>
          <input type="text" id="tripName" placeholder="Goa with the gang" required maxlength="60" autocomplete="off">
          <label for="yourName">Your name (shown on your photos)</label>
          <input type="text" id="yourName" placeholder="Srujan" value="${h(savedName())}" required maxlength="60" autocomplete="name">
          <button class="btn primary block" type="submit">Create trip &amp; get link</button>
        </form>
        ${trips.length ? `
        <div class="card">
          <h2>Your trips</h2>
          <ul class="list">
            ${trips.map(([code, t]) => `<li><a data-nav href="/t/${h(code)}">${h(t.tripName || code)}</a><span class="pill">${t.isOwner ? 'owner' : 'member'}</span></li>`).join('')}
          </ul>
        </div>` : ''}
        <form class="card" id="joinByCode">
          <h2>Have a code?</h2>
          <p>Someone sent you a link like <code>/t/abc123</code>? Paste the code here.</p>
          <div class="row">
            <input type="text" id="code" placeholder="trip code" style="flex:1" autocapitalize="none" autocomplete="off">
            <button class="btn" type="submit">Open</button>
          </div>
        </form>
        <p class="muted" style="margin-top:auto;text-align:center">Photos stay on your own server. Delete the trip, the photos are gone.</p>
      </div>`;

    $app.querySelector('#create').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = $app.querySelector('#tripName').value.trim();
      const creatorName = $app.querySelector('#yourName').value.trim();
      const btn = e.target.querySelector('button'); btn.disabled = true;
      try {
        localStorage.setItem(LS_NAME, creatorName);
        const { trip, member } = await api('POST', '/api/trips', { json: { name, creatorName } });
        saveTrip(trip.code, { token: member.token, memberId: member.id, name: member.name, tripName: trip.name, isOwner: true, joinedAt: Date.now() });
        navigate(`/t/${trip.code}?tab=share`);
      } catch (err) { toast(err.message, true); btn.disabled = false; }
    });
    $app.querySelector('#joinByCode').addEventListener('submit', (e) => {
      e.preventDefault();
      const raw = $app.querySelector('#code').value.trim();
      const code = (raw.match(/([a-z0-9]{6,16})\/?$/i) || [])[1];
      if (!code) return toast('That does not look like a trip code', true);
      navigate(`/t/${code.toLowerCase()}`);
    });
  }

  // ------------------------------------------------------------------ trip
  async function renderTrip(code) {
    $app.innerHTML = '<div class="loading">Opening trip…</div>';
    let info;
    try { info = await api('GET', `/api/trips/${code}`); }
    catch (err) {
      if (err.status === 410) {
        // Link was rotated. A member who is already in still has a valid token: forward them to the new code.
        const old = loadTrips()[code];
        if (old) {
          try {
            const me = await api('GET', `/api/trips/${code}/me`, { token: old.token });
            const all = loadTrips(); all[me.trip.code] = { ...old, tripName: me.trip.name, isOwner: me.member.isOwner, isOrganiser: me.member.isOrganiser, role: me.member.role }; delete all[code];
            localStorage.setItem(LS_TRIPS, JSON.stringify(all));
            history.replaceState({}, '', `/t/${me.trip.code}${location.search}`);
            return renderTrip(me.trip.code);
          } catch { /* token no longer valid: fall through to the expired screen */ }
        }
        forgetTrip(code);
        $app.innerHTML = `<div class="screen"><div class="card" id="expired"><h2>This link has expired</h2><p>The organiser created a new link for this trip. Ask them for it, or type the new code on the home page.</p><a class="btn" data-nav href="/">Go home</a></div></div>`;
        return;
      }
      if (err.status === 404) forgetTrip(code);
      $app.innerHTML = `<div class="screen"><div class="card"><h2>Trip not found</h2><p>${h(err.message)}. The link may be wrong or the trip was deleted.</p><a class="btn" data-nav href="/">Go home</a></div></div>`;
      return;
    }
    let rec = loadTrips()[code];
    if (!rec) {
      // Maybe this device joined under a code that was since rotated: adopt any stored token that this trip accepts.
      for (const [oldCode, r] of Object.entries(loadTrips())) {
        try {
          const me = await api('GET', `/api/trips/${code}/me`, { token: r.token });
          const all = loadTrips(); all[code] = { ...r, tripName: me.trip.name, isOwner: me.member.isOwner, isOrganiser: me.member.isOrganiser, role: me.member.role, status: me.member.status, name: me.member.name }; delete all[oldCode];
          localStorage.setItem(LS_TRIPS, JSON.stringify(all));
          rec = all[code];
          break;
        } catch { /* belongs to another trip */ }
      }
    }
    if (!rec) return renderJoin(code, info.trip);
    // Validate the stored token still works (trip may have been wiped server-side, or you were removed).
    try {
      const me = await api('GET', `/api/trips/${code}/me`, { token: rec.token });
      saveTrip(code, { isOwner: me.member.isOwner, isOrganiser: me.member.isOrganiser, role: me.member.role, status: me.member.status, tripName: me.trip.name, name: me.member.name });
      if (me.member.status === 'pending') return renderPending(code, me.trip);
    } catch (err) { if (err.status === 401) { forgetTrip(code); if (/removed|approve/i.test(err.message)) toast(err.message, true); return renderJoin(code, info.trip); } }
    return renderTripApp(code, loadTrips()[code], info.trip);
  }

  function renderJoin(code, trip) {
    applyBrand(trip);
    $app.innerHTML = `
      <div class="screen">
        <div class="hero">
          ${brandLogo(trip)}
          <h1>${h(trip.name)}</h1>
          <p>${trip.memberCount} ${trip.memberCount === 1 ? 'person' : 'people'} · ${trip.photoCount} photos so far</p>
        </div>
        <form class="card" id="join">
          <h2>Join this trip</h2>
          ${trip.preset === 'school' ? '<p><b>School trip.</b> First name only. The teacher approves who gets in.</p>' : '<p>Your name is shown next to the photos you add. Nothing else is collected.</p>'}
          <label for="name">${trip.preset === 'school' ? 'First name' : 'Your name'}</label>
          <input type="text" id="name" required maxlength="60" value="${h(savedName())}" autocomplete="name" placeholder="${trip.preset === 'school' ? 'First name' : 'Your name'}">
          ${trip.requiresPin ? '<label for="pin">PIN from the organiser</label><input type="text" id="pin" inputmode="numeric" pattern="[0-9]*" maxlength="8" required autocomplete="one-time-code" placeholder="4–8 digits">' : ''}
          ${trip.joinMode === 'approval' ? '<p class="muted">The organiser approves new members – you are in as soon as they say yes.</p>' : ''}
          <button class="btn primary block" type="submit">${trip.joinMode === 'approval' ? 'Ask to join' : 'Join &amp; open camera'}</button>
        </form>
        <p class="muted" style="text-align:center">You can add this page to your home screen later to use it like an app.</p>
      </div>`;
    $app.querySelector('#join').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = $app.querySelector('#name').value.trim();
      const pinEl = $app.querySelector('#pin');
      const btn = e.target.querySelector('button'); btn.disabled = true;
      try {
        localStorage.setItem(LS_NAME, name);
        const { member, trip: t } = await api('POST', `/api/trips/${code}/join`, { json: { name, pin: pinEl ? pinEl.value.trim() : undefined } });
        saveTrip(code, { token: member.token, memberId: member.id, name: member.name, tripName: t.name, isOwner: false, isOrganiser: false, role: member.role, status: member.status, joinedAt: Date.now() });
        if (member.status === 'pending') return renderPending(code, t);
        render();
      } catch (err) { toast(err.message, true); btn.disabled = false; }
    });
  }

  /** Approval mode: the joiner waits here; we poll /me until the organiser decides. */
  function renderPending(code, trip) {
    applyBrand(trip);
    let timer = null;
    teardown = () => clearTimeout(timer);
    $app.innerHTML = `
      <div class="screen">
        <div class="hero">${brandLogo(trip)}<h1>${h(trip.name)}</h1></div>
        <div class="card" id="pending">
          <h2>Waiting for the organiser</h2>
          <p>Your request to join is with the organiser. This page updates itself the moment they say yes – you can also come back to the link later.</p>
          <div class="muted" id="pending-status">Checking…</div>
          <a class="btn" data-nav href="/" style="margin-top:12px">Home</a>
        </div>
      </div>`;
    const check = async () => {
      const rec = loadTrips()[code];
      if (!rec) return;
      try {
        const me = await api('GET', `/api/trips/${code}/me`, { token: rec.token });
        if (me.member.status === 'active') { saveTrip(code, { status: 'active', role: me.member.role, isOrganiser: me.member.isOrganiser }); toast('You are in!'); return render(); }
        const el = $app.querySelector('#pending-status'); if (el) el.textContent = `Still waiting · last checked ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
      } catch (err) {
        if (err.status === 401) { forgetTrip(code); const el = $app.querySelector('#pending'); if (el) el.innerHTML = `<h2>Not approved</h2><p>${h(err.message)}</p><a class="btn" data-nav href="/">Home</a>`; return; }
      }
      timer = setTimeout(check, 4000);
    };
    check();
  }

  function renderTripApp(code, rec, trip) {
    applyBrand(trip);
    metaSet('lastTrip', code).catch(() => {});   // the share target (sw.js) queues shared files for this trip
    const params = new URLSearchParams(location.search);
    if (params.get('shared')) {
      const n = Number(params.get('shared'));
      if (n) { toast(`${n} shared ${n === 1 ? 'file' : 'files'} added to ${trip.name}`); syncQueue(); }
      history.replaceState({}, '', `/t/${code}`);
    }
    let tab = params.get('tab') || 'camera';
    const cleanups = [];
    teardown = () => cleanups.splice(0).forEach((fn) => fn());

    $app.innerHTML = `
      <div class="screen with-tabs">
        <div class="trip-header">
          ${trip.brand && trip.brand.logoUrl ? `<img class="brand-logo" src="${h(trip.brand.logoUrl)}" alt="">` : ''}
          <div><h1>${h(trip.name)}</h1><div class="muted" id="hdr-stats">${trip.memberCount} ${trip.memberCount === 1 ? 'person' : 'people'} · ${trip.photoCount} photo${trip.photoCount === 1 ? '' : 's'}</div>${fmtRange(trip) ? `<div class="muted" id="hdr-dates">${h(fmtRange(trip))}</div>` : ''}</div>
          <a data-nav href="/">All trips</a>
        </div>
        <div id="banners"></div>
        <div id="tab-body"></div>
      </div>
      <nav class="tabs" id="tabs">
        <button data-tab="camera"><span class="ic">📷</span>Camera<span class="badge" id="queue-badge" hidden></span></button>
        <button data-tab="photos"><span class="ic">🖼️</span>Photos</button>
        <button data-tab="share"><span class="ic">🔗</span>Share</button>
      </nav>`;

    const $body = $app.querySelector('#tab-body');
    const $badge = $app.querySelector('#queue-badge');
    let tabCleanup = null;

    async function refreshBadge() {
      const n = (await qAll()).filter((i) => i.code === code && i.kind !== 'comment').length;
      $badge.hidden = n === 0; $badge.textContent = n;
    }
    async function refreshHeader() {
      try {
        const { trip: t } = await api('GET', `/api/trips/${code}`);
        $app.querySelector('#hdr-stats').textContent = `${t.memberCount} ${t.memberCount === 1 ? 'person' : 'people'} · ${t.photoCount} photo${t.photoCount === 1 ? '' : 's'} · ${fmtBytes(t.totalBytes)}`;
      } catch { /* offline: keep last known */ }
    }
    cleanups.push(onSync((ev) => { refreshBadge(); if (ev.type === 'done') { refreshHeader(); maybeOfferPush(); } }));
    refreshBadge();
    refreshHeader();
    const hdrTimer = setInterval(() => { if (!document.hidden) refreshHeader(); }, 30000);
    cleanups.push(() => clearInterval(hdrTimer));

    // ---- banners: push opt-in after the first upload; "who's missing" for a lonely organiser after 24h
    const $banners = $app.querySelector('#banners');
    function maybeOfferPush() {
      if (!pushSupported() || Notification.permission === 'denied') return;
      if (localStorage.getItem(`triplink:push:${code}`) || $banners.querySelector('#push-banner')) return;
      const el = document.createElement('div');
      el.className = 'banner'; el.id = 'push-banner';
      el.innerHTML = `<div><b>Get a ping when others add photos?</b><div class="muted">One notification per batch, never more than twice an hour.</div></div>
        <div class="row"><button class="btn small primary" id="push-yes">Enable</button><button class="btn small" id="push-no">Not now</button></div>`;
      $banners.appendChild(el);
      el.querySelector('#push-yes').onclick = async () => {
        try { await subscribePush(code, rec); toast('Notifications on'); el.remove(); }
        catch (err) { toast(err.message, true); localStorage.setItem(`triplink:push:${code}`, 'off'); el.remove(); }
      };
      el.querySelector('#push-no').onclick = () => { localStorage.setItem(`triplink:push:${code}`, 'dismissed'); el.remove(); };
    }
    function maybeNudgeMissing() {
      const ageMs = Date.now() - (trip.createdAt || Date.now());
      if (!rec.isOwner || trip.memberCount >= 3 || ageMs < 24 * 3600 * 1000) return;
      if (localStorage.getItem(`triplink:nudge:${code}`) || $banners.querySelector('#missing-banner')) return;
      const el = document.createElement('div');
      el.className = 'banner'; el.id = 'missing-banner';
      el.innerHTML = `<div><b>${trip.memberCount === 1 ? 'Only you so far.' : `Only ${trip.memberCount} people so far.`}</b><div class="muted">Most people miss the first message. Send the link again, or show the QR at dinner.</div></div>
        <div class="row"><button class="btn small primary" id="nudge-share">Share again</button><button class="btn small" id="nudge-no">Dismiss</button></div>`;
      $banners.appendChild(el);
      el.querySelector('#nudge-share').onclick = async () => { await shareLink(trip, tripLink(code, trip)); showTab('share'); };
      el.querySelector('#nudge-no').onclick = () => { localStorage.setItem(`triplink:nudge:${code}`, '1'); el.remove(); };
    }
    maybeNudgeMissing();

    function showTab(name) {
      tab = name;
      history.replaceState({}, '', `/t/${code}${name === 'camera' ? '' : `?tab=${name}`}`);
      $app.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
      if (tabCleanup) { tabCleanup(); tabCleanup = null; }
      $body.innerHTML = '';
      if (name === 'camera') tabCleanup = tabCamera($body, code, rec, trip);
      else if (name === 'photos') tabCleanup = tabPhotos($body, code, rec, trip);
      else tabCleanup = tabShare($body, code, rec, trip);
    }
    cleanups.push(() => tabCleanup && tabCleanup());
    $app.querySelector('#tabs').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-tab]'); if (b) showTab(b.dataset.tab);
    });
    showTab(tab);
  }

  // ---------------------------------------------------------------- camera
  function tabCamera($el, code, rec, trip) {
    $el.innerHTML = `
      <div class="camera" id="cam">
        <video id="video" autoplay playsinline muted></video>
        <div class="flash" id="flash"></div>
        <div class="rec-badge" id="rec-badge" hidden>● REC <span id="rec-time">0:00</span></div>
        <div class="cam-msg" id="cam-msg" hidden></div>
      </div>
      <div class="cam-controls">
        <img class="last-shot" id="last" alt="" hidden>
        <button class="icon-btn" id="last-ph" aria-hidden="true" style="visibility:hidden"></button>
        <button class="shutter" id="shutter" aria-label="Take photo"></button>
        <div class="col">
          <button class="icon-btn" id="record" title="Record video (max 60 s)" aria-label="Record video">🎥</button>
          <button class="icon-btn" id="flip" title="Switch camera" aria-label="Switch camera">🔄</button>
        </div>
      </div>
      <div class="upload-status" id="status"></div>
      <div class="file-fallback">
        <label class="btn small" for="file">➕ Add from gallery / system camera</label>
        <input type="file" id="file" accept="image/*,video/*" multiple>
      </div>
      <div class="toggles">
        <label class="toggle"><input type="checkbox" id="wifi-only" ${wifiOnly() ? 'checked' : ''}> Upload on Wi-Fi only${navigator.connection && navigator.connection.type ? '' : ' <span class="muted">(this browser cannot tell the connection type, so uploads continue)</span>'}</label>
        <label class="toggle"><input type="checkbox" id="pause" ${isPaused() ? 'checked' : ''}> Pause uploads (photos stay saved on this phone)</label>
      </div>`;
    $el.querySelector('#wifi-only').onchange = (e) => { localStorage.setItem(LS_WIFI, e.target.checked ? '1' : '0'); syncQueue(); };
    $el.querySelector('#pause').onchange = (e) => { localStorage.setItem(LS_PAUSED, e.target.checked ? '1' : '0'); if (!e.target.checked) syncQueue(); else refreshStatus(); };
    const $video = $el.querySelector('#video');
    const $cam = $el.querySelector('#cam');
    const $msg = $el.querySelector('#cam-msg');
    const $status = $el.querySelector('#status');
    const $last = $el.querySelector('#last');
    const $lastPh = $el.querySelector('#last-ph');
    let stream = null;
    let facing = localStorage.getItem('triplink:facing') || 'environment';

    async function start() {
      stop();
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        $msg.hidden = false; $msg.textContent = 'Live camera is not available here. Use "Add from gallery / system camera" below.'; return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: facing }, width: { ideal: 4096 }, height: { ideal: 3072 } }, audio: false,
        });
        $video.srcObject = stream;
        $cam.classList.toggle('mirror', facing === 'user');
        $msg.hidden = true;
      } catch (err) {
        $msg.hidden = false;
        $msg.textContent = err.name === 'NotAllowedError'
          ? 'Camera permission was denied. Allow it in your browser settings, or use "Add from gallery" below.'
          : `Could not start the camera (${err.name}). Use "Add from gallery" below.`;
      }
    }
    function stop() { if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; } }
    start();

    function showLast(blob) {
      if (!blob) return;
      if ($last.src) URL.revokeObjectURL($last.src);
      $last.src = URL.createObjectURL(blob); $last.hidden = false; $lastPh.style.display = 'none';
    }

    $el.querySelector('#shutter').addEventListener('click', async () => {
      if (!stream || !$video.videoWidth) return toast('Camera is not ready', true);
      const $flash = $el.querySelector('#flash');
      $flash.classList.add('on'); setTimeout(() => $flash.classList.remove('on'), 60);
      if (navigator.vibrate) navigator.vibrate(15);
      try {
        const thumb = await enqueueCapture(code, $video, Date.now());
        showLast(thumb);
      } catch (err) { toast(`Could not save photo: ${err.message}`, true); }
    });
    $el.querySelector('#flip').addEventListener('click', () => {
      if (recorder) return toast('Stop recording first', true);
      facing = facing === 'environment' ? 'user' : 'environment';
      localStorage.setItem('triplink:facing', facing);
      start();
    });
    $el.querySelector('#file').addEventListener('change', async (e) => {
      const files = [...e.target.files];
      e.target.value = '';
      let n = 0;
      for (const f of files) {
        try { const t = await enqueueFile(code, f, !!(trip && trip.keepOriginals)); if (t) showLast(t); n++; }
        catch (err) { toast(`Skipped ${f.name}: ${err.message}`, true); }
      }
      if (n) toast(`${n} ${n > 1 ? 'items' : 'item'} added to the trip`);
    });

    // ---- video recording: MediaRecorder on a downscaled canvas copy of the live stream (max 1280 px, 60 s).
    // Recording the raw 4K stream makes software encoders on phones (and headless test browsers) fall behind.
    let recorder = null, recChunks = [], recTimer = null, recStart = 0, recPoster = null, recCanvas = null, recRaf = 0;
    const $rec = $el.querySelector('#record');
    const $recBadge = $el.querySelector('#rec-badge');
    const REC_EDGE = 1280;
    // Safari records H.264 MP4 natively (plays everywhere); Chromium/Firefox do VP8 WebM fast. Chromium's
    // "video/mp4" is VP9-in-MP4, slow and not iOS-friendly, so it comes last.
    const mimeCandidates = ['video/mp4;codecs=avc1', 'video/mp4;codecs=h264', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
    async function startRecording() {
      if (!stream || !$video.videoWidth || !window.MediaRecorder) return toast('Video recording is not supported here', true);
      const mimeType = mimeCandidates.find((m) => MediaRecorder.isTypeSupported(m)) || '';
      const scale = Math.min(1, REC_EDGE / Math.max($video.videoWidth, $video.videoHeight));
      recCanvas = document.createElement('canvas');
      recCanvas.width = Math.round($video.videoWidth * scale); recCanvas.height = Math.round($video.videoHeight * scale);
      const ctx = recCanvas.getContext('2d');
      const draw = () => { ctx.drawImage($video, 0, 0, recCanvas.width, recCanvas.height); recRaf = requestAnimationFrame(draw); };
      draw();
      recPoster = await new Promise((res) => recCanvas.toBlob(res, 'image/jpeg', 0.7));
      const canvasStream = recCanvas.captureStream(30);
      recChunks = [];
      recorder = new MediaRecorder(canvasStream, mimeType ? { mimeType, videoBitsPerSecond: 2_500_000 } : { videoBitsPerSecond: 2_500_000 });
      recorder.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
      recorder.onstop = async () => {
        cancelAnimationFrame(recRaf);
        canvasStream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(recChunks, { type: recorder.mimeType || mimeType || 'video/webm' });
        const duration = (Date.now() - recStart) / 1000;
        const w = recCanvas.width, hgt = recCanvas.height;
        recorder = null; clearInterval(recTimer); $recBadge.hidden = true; $rec.classList.remove('recording'); $rec.textContent = '🎥';
        if (blob.size < 1000) return toast('Recording was empty – try again', true);
        try {
          await qAdd({ code, kind: 'video', takenAt: recStart, width: w, height: hgt, duration, blob, thumb: recPoster, original: null, addedAt: Date.now() });
          syncQueue(); showLast(recPoster);
        } catch (err) { toast(`Could not save video: ${err.message}`, true); }
      };
      recorder.start(1000);
      recStart = Date.now();
      $rec.classList.add('recording'); $rec.textContent = '⏹'; $recBadge.hidden = false;
      recTimer = setInterval(() => {
        const s = Math.floor((Date.now() - recStart) / 1000);
        $el.querySelector('#rec-time').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
        if (s >= MAX_VIDEO_SECONDS) stopRecording();
      }, 250);
    }
    function stopRecording() { if (recorder && recorder.state !== 'inactive') recorder.stop(); }
    $rec.addEventListener('click', () => (recorder ? stopRecording() : startRecording()));

    async function refreshStatus(ev) {
      const items = (await qAll()).filter((i) => i.code === code && i.kind !== 'comment');
      const n = items.length;
      const blocker = uploadBlocker();
      if (blocker && n) { $status.textContent = blocker === 'paused' ? `Paused – ${n} saved on this phone` : `Waiting for Wi-Fi – ${n} saved on this phone`; return; }
      if (!ev) { if (n) $status.textContent = `${n} waiting to upload`; return; }
      if (ev.type === 'start') $status.textContent = `Uploading… ${n} left`;
      else if (ev.type === 'progress') $status.textContent = `Uploading… ${Math.round(ev.frac * 100)}% (${n} left)`;
      else if (ev.type === 'done') $status.textContent = (ev.duplicate ? 'Already in the trip. ' : '') + (n ? `Uploaded. ${n} left` : 'All photos are in the trip ✓');
      else if (ev.type === 'offline') $status.textContent = `Offline – ${n} saved, will upload when back online`;
      else if (ev.type === 'blocked') $status.textContent = ev.reason === 'paused' ? `Paused – ${n} saved on this phone` : `Waiting for Wi-Fi – ${n} saved on this phone`;
      else if (ev.type === 'failed') { $status.textContent = `A file was rejected: ${ev.error}`; toast(ev.error, true); }
      else if (ev.type === 'idle' && !n) setTimeout(() => { if (!$status.textContent.includes('rejected')) $status.textContent = ''; }, 2500);
    }
    const unsub = onSync(refreshStatus);
    qAll().then((items) => { const n = items.filter((i) => i.code === code && i.kind !== 'comment').length; if (n) { refreshStatus(); syncQueue(); } });

    const onVis = () => { if (document.hidden) { stopRecording(); stop(); } else if (!stream) start(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { stopRecording(); stop(); unsub(); document.removeEventListener('visibilitychange', onVis); };
  }

  // ---------------------------------------------------------------- photos (public/gallery.js)
  const gallery = window.TripLinkGallery({ api, toast, h, fmtBytes, fmtTime, fmtDate, keptUntil, qAll, qAdd, onSync, syncQueue: (...a) => syncQueue(...a), isIOS, isStandalone, $app });
  const tabPhotos = gallery.tabPhotos;

  // ----------------------------------------------------------------- share
  let deferredInstall = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; });

  function tabShare($el, code, rec, trip) {
    const link = tripLink(code, trip);
    const msg = shareMessage(trip, link);
    const enc = encodeURIComponent(msg);
    const standalone = isStandalone();
    const pushState = localStorage.getItem(`triplink:push:${code}`);
    const canManage = !!rec.isOrganiser;
    $el.innerHTML = `
      <div class="card">
        <h2>Invite everyone</h2>
        <p>Anyone who opens this link ${trip.joinMode === 'approval' ? 'asks to join and gets in once an organiser approves' : 'joins the trip'}${trip.requiresPin ? ' – they will need the PIN' : ''}. No account needed.</p>
        <div class="linkbox"><input type="text" id="link" readonly value="${h(link)}"><button class="btn" id="copy">Copy</button></div>
        <button class="btn primary block" id="share">📤 Share link…</button>
        <div class="share-row">
          <a class="btn small" id="share-wa" href="https://wa.me/?text=${enc}" target="_blank" rel="noopener">WhatsApp</a>
          <a class="btn small" id="share-tg" href="https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(`Join "${trip.name}" on TripLink and add your photos – no sign-up`)}" target="_blank" rel="noopener">Telegram</a>
          <a class="btn small" id="share-sms" href="sms:?&body=${enc}">SMS</a>
          <button class="btn small" id="share-copy">Copy message</button>
        </div>
        <div class="qr-box">
          <div class="qr" id="qr">${qrSvg(link, 5)}</div>
          <div>
            <div class="muted">Show this at the table, everyone scans it with their camera.</div>
            <div class="code-big" id="code-big">${h(code)}</div>
            <div class="muted">…or they type this code on the home page.</div>
            <a class="btn small" style="margin-top:8px" data-nav href="/t/${h(code)}/card" id="print-card">🖨 Print join card</a>
          </div>
        </div>
      </div>
      ${!standalone ? `
      <div class="card install-hint">
        <h2>Use it like an app</h2>
        ${deferredInstall ? '<button class="btn block" id="install">📲 Add to home screen</button>'
          : isIOS() ? '<p>On iPhone: tap the <b>Share</b> button in Safari, then <b>Add to Home Screen</b>. You get a full-screen camera with an icon.</p>'
          : '<p>Open the browser menu and choose <b>Add to Home Screen</b> / <b>Install app</b>.</p>'}
      </div>` : ''}
      ${pushSupported() ? `
      <div class="card">
        <div class="row between"><h2>Notifications</h2><button class="btn small" id="push-toggle">${pushState === 'on' ? 'Turn off' : 'Turn on'}</button></div>
        <p class="muted" id="push-desc">${pushState === 'on' ? 'You get a ping when others add photos, and a recap when the trip goes quiet.' : 'Get a ping when others add photos (at most twice an hour) and a recap two days after the last upload.'}</p>
      </div>` : ''}
      ${canManage ? '<div class="card" id="pending-card" hidden><h2>Waiting to join</h2><ul class="list" id="pending-list"></ul></div>' : ''}
      <div class="card">
        <div class="row between"><h2>Who is in</h2><button class="btn small" id="rename-me">Change my name</button></div>
        <ul class="list" id="members"><li class="muted">Loading…</li></ul>
      </div>
      <div class="card">
        <h2>Everyone gets everything</h2>
        <p>Open <b>Photos → Download all</b> to get a single .zip of every photo from every phone, named by time and person.</p>
        <p class="muted" id="expiry">${h(keptUntil(trip))}${canManage ? '' : ' The organiser can extend this.'}</p>
        ${canManage ? '<button class="btn small" id="extend">Keep for 90 more days</button>' : ''}
        <button class="btn danger small" id="leave" style="margin-left:6px">Leave trip on this device</button>
      </div>
      ${canManage ? `
      <form class="card" id="trip-settings">
        <h2>Trip settings</h2>
        <label for="set-name">Trip name</label>
        <input type="text" id="set-name" value="${h(trip.name)}" maxlength="60" required>
        <div class="row">
          <div style="flex:1"><label for="set-start">Start date</label><input type="date" id="set-start" value="${h(trip.startDate || '')}"></div>
          <div style="flex:1"><label for="set-end">End date</label><input type="date" id="set-end" value="${h(trip.endDate || '')}"></div>
        </div>
        <label class="toggle" style="margin-top:12px"><input type="checkbox" id="set-originals" ${trip.keepOriginals ? 'checked' : ''}> Keep original files <span class="muted">(full quality, bigger zip; photos are still shown resized)</span></label>
        <label class="toggle"><input type="checkbox" id="set-comments" ${trip.commentsEnabled === false ? '' : 'checked'}> Allow comments on photos</label>
        <h2 style="font-size:16px;margin-top:14px">Who can get in</h2>
        <label for="set-join">Joining</label>
        <select id="set-join" class="select">
          <option value="open" ${trip.joinMode !== 'approval' ? 'selected' : ''}>Anyone with the link joins straight away</option>
          <option value="approval" ${trip.joinMode === 'approval' ? 'selected' : ''}>People ask to join, an organiser approves</option>
        </select>
        <label for="set-pin">PIN ${trip.requiresPin ? '<span class="pill ok">set</span>' : '<span class="pill">none</span>'}</label>
        <div class="row">
          <input type="text" id="set-pin" inputmode="numeric" pattern="[0-9]*" maxlength="8" placeholder="${trip.requiresPin ? 'Leave empty to keep the current PIN' : '4–8 digits, optional'}" style="flex:1" autocomplete="off">
          ${trip.requiresPin ? '<label class="toggle" style="flex:0 0 auto"><input type="checkbox" id="set-pin-clear"> Remove PIN</label>' : ''}
        </div>
        <div class="row" style="margin-top:10px">
          <button class="btn small ${trip.preset === 'school' ? 'primary' : ''}" type="button" id="preset-school">${trip.preset === 'school' ? '🏫 School mode is on – turn off' : '🏫 School mode preset'}</button>
          <span class="muted" style="font-size:12px">Approval on, first names only, no comments, photos gone after 30 days.</span>
        </div>
        <h2 style="font-size:16px;margin-top:14px">Look</h2>
        <div class="row">
          <label class="toggle" style="flex:0 0 auto"><input type="color" id="set-brand" value="${h((trip.brand && trip.brand.color) || '#ffb84d')}"> Accent colour</label>
          <button class="btn small" type="button" id="brand-reset">Default colour</button>
          <label class="btn small" for="set-logo">${trip.brand && trip.brand.logoUrl ? 'Replace logo' : 'Add a logo'}</label>
          <input type="file" id="set-logo" accept="image/png,image/jpeg,image/webp" hidden>
        </div>
        <button class="btn primary block" type="submit" id="save-settings">Save</button>
      </form>
      <div class="card danger-zone">
        <h2>Organiser tools</h2>
        <p><b>New link.</b> If the link leaked to people who should not be in, make a new one. The old link stops working; everyone already in stays in.</p>
        <button class="btn small" id="rotate">🔁 Make a new link</button>
        ${rec.isOwner ? `
        <p style="margin-top:16px"><b>Delete trip.</b> Removes every photo from every person, permanently. Download the zip first.</p>
        <button class="btn danger small" id="delete-trip">Delete trip…</button>
        <div id="delete-confirm" class="confirm-box" hidden>
          <p>This cannot be undone. ${trip.photoCount} photo${trip.photoCount === 1 ? '' : 's'} from ${trip.memberCount} ${trip.memberCount === 1 ? 'person' : 'people'} will be erased.</p>
          <div class="row"><button class="btn danger small" id="delete-trip-confirm">Yes, delete everything</button><button class="btn small" id="delete-cancel">Cancel</button></div>
        </div>` : '<p class="muted" style="margin-top:12px">Only the trip owner can delete the trip or change who is an organiser.</p>'}
      </div>` : ''}`;
    $el.querySelector('#copy').onclick = async () => {
      try { await navigator.clipboard.writeText(link); toast('Link copied'); }
      catch { $el.querySelector('#link').select(); document.execCommand('copy'); toast('Link copied'); }
    };
    $el.querySelector('#share').onclick = () => shareLink(trip, link);
    $el.querySelector('#share-copy').onclick = async () => { await navigator.clipboard.writeText(msg).catch(() => {}); toast('Message copied'); };
    const $pushToggle = $el.querySelector('#push-toggle');
    if ($pushToggle) $pushToggle.onclick = async () => {
      $pushToggle.disabled = true;
      try {
        if (localStorage.getItem(`triplink:push:${code}`) === 'on') { await unsubscribePush(code, rec); $pushToggle.textContent = 'Turn on'; toast('Notifications off'); }
        else { await subscribePush(code, rec); $pushToggle.textContent = 'Turn off'; toast('Notifications on'); }
      } catch (err) { toast(err.message, true); }
      finally { $pushToggle.disabled = false; }
    };
    const $install = $el.querySelector('#install');
    if ($install) $install.onclick = async () => { deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null; $install.remove(); };
    $el.querySelector('#leave').onclick = () => { if (confirm('Remove this trip from this device? Your uploaded photos stay in the trip.')) { forgetTrip(code); navigate('/'); } };

    async function loadMembers() {
      try {
        const { members, pending } = await api('GET', `/api/trips/${code}/members`, { token: rec.token });
        $el.querySelector('#members').innerHTML = members.map((m) => `<li>
            <span>${h(m.name)}${m.isOwner ? ' <span class="pill">owner</span>' : m.isOrganiser ? ' <span class="pill warn">organiser</span>' : ''}${m.id === rec.memberId ? ' <span class="pill ok">you</span>' : ''}</span>
            <span class="row"><span class="muted">${m.photoCount} photos</span>
              ${rec.isOwner && !m.isOwner ? `<button class="btn small role-toggle" data-id="${m.id}" data-role="${m.isOrganiser ? 'member' : 'organiser'}" title="${m.isOrganiser ? 'Remove organiser rights' : 'Make organiser'}">${m.isOrganiser ? '⭐︎ Demote' : '⭐ Make organiser'}</button>` : ''}
              ${canManage && !m.isOwner && m.id !== rec.memberId && (rec.isOwner || !m.isOrganiser) ? `<button class="btn small remove-member" data-id="${m.id}" data-name="${h(m.name)}" data-photos="${m.photoCount}" title="Remove from trip">✕</button>` : ''}</span>
          </li>`).join('') || '<li class="muted">Nobody yet</li>';
        const $pc = $el.querySelector('#pending-card');
        if ($pc) {
          $pc.hidden = !(pending && pending.length);
          $el.querySelector('#pending-list').innerHTML = (pending || []).map((m) => `<li><span>${h(m.name)} <span class="muted">asked ${fmtTime(m.joinedAt)}</span></span>
              <span class="row"><button class="btn small primary approve" data-id="${m.id}">Approve</button><button class="btn small reject" data-id="${m.id}">Reject</button></span></li>`).join('');
        }
      } catch (err) { toast(err.message, true); }
    }
    $el.addEventListener('click', async (e) => {
      const rm = e.target.closest('button.remove-member');
      if (rm) {
        const n = Number(rm.dataset.photos);
        if (!confirm(`Remove ${rm.dataset.name} from the trip? They will need a new link to get back in.`)) return;
        const deletePhotos = n > 0 && confirm(`Also delete the ${n} photo${n === 1 ? '' : 's'} ${rm.dataset.name} added?\n\nOK = delete their photos too · Cancel = keep the photos`);
        try { await api('DELETE', `/api/trips/${code}/members/${rm.dataset.id}${deletePhotos ? '?deletePhotos=1' : ''}`, { token: rec.token }); toast(`${rm.dataset.name} removed`); loadMembers(); }
        catch (err) { toast(err.message, true); }
        return;
      }
      const role = e.target.closest('button.role-toggle');
      if (role) {
        try { await api('POST', `/api/trips/${code}/members/${role.dataset.id}/role`, { token: rec.token, json: { role: role.dataset.role } }); toast(role.dataset.role === 'organiser' ? 'Now an organiser' : 'Organiser rights removed'); loadMembers(); }
        catch (err) { toast(err.message, true); }
        return;
      }
      const dec = e.target.closest('button.approve, button.reject');
      if (dec) {
        const approve = dec.classList.contains('approve');
        try { await api('POST', `/api/trips/${code}/members/${dec.dataset.id}/${approve ? 'approve' : 'reject'}`, { token: rec.token }); toast(approve ? 'Approved' : 'Rejected'); loadMembers(); }
        catch (err) { toast(err.message, true); }
      }
    });
    $el.querySelector('#rename-me').onclick = async () => {
      const name = (prompt('Your name, as shown on your photos:', rec.name) || '').trim();
      if (!name || name === rec.name) return;
      try {
        const { member } = await api('PATCH', `/api/trips/${code}/me`, { token: rec.token, json: { name } });
        saveTrip(code, { name: member.name }); rec.name = member.name; localStorage.setItem(LS_NAME, member.name);
        toast('Name updated'); loadMembers();
      } catch (err) { toast(err.message, true); }
    };
    loadMembers();
    let membersTimer = canManage ? setInterval(() => { if (!document.hidden) loadMembers(); }, 8000) : null;   // pending requests show up without a reload

    if (canManage) {
      let presetPending;   // undefined = unchanged, 'school' | null
      $el.querySelector('#preset-school').onclick = () => {
        presetPending = trip.preset === 'school' ? null : 'school';
        const b = $el.querySelector('#preset-school'); b.textContent = presetPending ? '🏫 School mode will be turned on – press Save' : '🏫 School mode will be turned off – press Save';
        if (presetPending) { $el.querySelector('#set-join').value = 'approval'; $el.querySelector('#set-comments').checked = false; }
      };
      let brandCleared = false;
      $el.querySelector('#brand-reset').onclick = () => { brandCleared = true; $el.querySelector('#set-brand').value = '#ffb84d'; toast('Default colour will be restored on Save'); };
      $el.querySelector('#set-logo').onchange = async (e) => {
        const f = e.target.files[0]; if (!f) return;
        if (f.size > 200 * 1024) return toast('Logo must be under 200 KB', true);
        try { await api('POST', `/api/trips/${code}/brand-logo`, { token: rec.token, body: f, headers: { 'Content-Type': f.type || 'application/octet-stream' } }); toast('Logo updated'); render(); }
        catch (err) { toast(err.message, true); }
      };
      $el.querySelector('#trip-settings').addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = $el.querySelector('#save-settings'); btn.disabled = true;
        const pinVal = $el.querySelector('#set-pin').value.trim();
        const pinClear = $el.querySelector('#set-pin-clear') && $el.querySelector('#set-pin-clear').checked;
        const color = $el.querySelector('#set-brand').value;
        const json = {
          name: $el.querySelector('#set-name').value.trim(),
          startDate: $el.querySelector('#set-start').value || null,
          endDate: $el.querySelector('#set-end').value || null,
          keepOriginals: $el.querySelector('#set-originals').checked,
          commentsEnabled: $el.querySelector('#set-comments').checked,
          joinMode: $el.querySelector('#set-join').value,
        };
        if (presetPending !== undefined) json.preset = presetPending;
        if (pinClear) json.pin = null; else if (pinVal) json.pin = pinVal;
        if (brandCleared) json.brandColor = null; else if (color && color.toLowerCase() !== '#ffb84d') json.brandColor = color;
        try { await api('PATCH', `/api/trips/${code}`, { token: rec.token, json }); toast('Saved'); render(); }
        catch (err) { toast(err.message, true); btn.disabled = false; }
      });
      $el.querySelector('#extend').onclick = async () => {
        try {
          const { trip: t } = await api('PATCH', `/api/trips/${code}`, { token: rec.token, json: { extendDays: 90 } });
          $el.querySelector('#expiry').textContent = keptUntil(t); toast('Extended');
        } catch (err) { toast(err.message, true); }
      };
      $el.querySelector('#rotate').onclick = async () => {
        if (!confirm('Make a new link? The current link and code will stop working immediately.')) return;
        try {
          const { trip: t } = await api('POST', `/api/trips/${code}/rotate`, { token: rec.token });
          const all = loadTrips(); all[t.code] = all[code]; delete all[code]; localStorage.setItem(LS_TRIPS, JSON.stringify(all));
          toast('New link ready – share it again'); navigate(`/t/${t.code}?tab=share`);
        } catch (err) { toast(err.message, true); }
      };
      if (rec.isOwner) {
        $el.querySelector('#delete-trip').onclick = () => { $el.querySelector('#delete-confirm').hidden = false; $el.querySelector('#delete-trip').hidden = true; };
        $el.querySelector('#delete-cancel').onclick = () => { $el.querySelector('#delete-confirm').hidden = true; $el.querySelector('#delete-trip').hidden = false; };
        $el.querySelector('#delete-trip-confirm').onclick = async () => {
          const btn = $el.querySelector('#delete-trip-confirm'); btn.disabled = true;
          try { await api('DELETE', `/api/trips/${code}`, { token: rec.token }); forgetTrip(code); toast('Trip deleted'); navigate('/'); }
          catch (err) { toast(err.message, true); btn.disabled = false; }
        };
      }
    }
    return () => { if (membersTimer) clearInterval(membersTimer); };
  }

  // ------------------------------------------------------------------ boot
  window.TripLink = { queueSize: async () => (await qAll()).length, sync: syncQueue };
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  render();
  syncQueue();
})();
