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

  // ------------------------------------------------------------------ utils
  const h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtBytes = (n) => n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
  const fmtTime = (ms) => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
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
    if (!res.ok) { const e = new Error((data && data.error) || `HTTP ${res.status}`); e.status = res.status; throw e; }
    return data;
  }

  // ------------------------------------------------------------ upload queue
  const QDB = 'triplink-queue';
  function openQueue() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open(QDB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore('queue', { keyPath: 'id', autoIncrement: true });
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
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

  let syncing = false;
  const syncListeners = new Set();
  function onSync(fn) { syncListeners.add(fn); return () => syncListeners.delete(fn); }
  function notifySync(ev) { for (const fn of syncListeners) fn(ev); }

  async function syncQueue() {
    if (syncing) return;
    syncing = true;
    try {
      const items = await qAll();
      for (const item of items) {
        const rec = loadTrips()[item.code];
        if (!rec) { await qDel(item.id); continue; }
        notifySync({ type: 'start', item, remaining: items.length });
        try {
          const meta = JSON.stringify({ takenAt: item.takenAt, width: item.width, height: item.height });
          const { photo } = await api('POST', `/api/trips/${item.code}/photos`, {
            body: item.blob, token: rec.token, headers: { 'Content-Type': item.blob.type || 'application/octet-stream', 'X-Photo-Meta': meta },
          });
          if (item.thumb) {
            try { await api('POST', `/api/trips/${item.code}/photos/${photo.id}/thumb`, { body: item.thumb, token: rec.token, headers: { 'Content-Type': 'image/jpeg' } }); }
            catch { /* thumbnail is optional */ }
          }
          await qDel(item.id);
          notifySync({ type: 'done', item, photo });
        } catch (err) {
          // Permanent failures: drop the item so the queue can't wedge. Network errors: stop and retry later.
          if (err.status && err.status !== 429 && err.status < 500) {
            await qDel(item.id);
            notifySync({ type: 'failed', item, error: err.message });
            continue;
          }
          notifySync({ type: 'offline', item, error: err.message });
          break;
        }
      }
    } finally {
      syncing = false;
      notifySync({ type: 'idle' });
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
  async function enqueueCapture(code, source, takenAt) {
    const full = await drawScaled(source, MAX_LONG_EDGE, 0.9);
    const thumb = await drawScaled(source, THUMB_EDGE, 0.7);
    await qAdd({ code, takenAt, width: full.width, height: full.height, blob: full.blob, thumb: thumb.blob, addedAt: Date.now() });
    syncQueue();
    return thumb.blob;
  }
  async function enqueueFile(code, file) {
    const takenAt = file.lastModified || Date.now();
    try {
      const bmp = await decode(file);
      const t = await enqueueCapture(code, bmp, takenAt);
      if (bmp.close) bmp.close();
      return t;
    } catch {
      // Could not decode client-side (rare): upload the raw file, server sniffs the type.
      await qAdd({ code, takenAt, width: null, height: null, blob: file, thumb: null, addedAt: Date.now() });
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
    const m = location.pathname.match(/^\/t\/([a-z0-9]{6,16})\/?$/i);
    if (m) return renderTrip(m[1].toLowerCase());
    return renderHome();
  }

  // ------------------------------------------------------------------ home
  function renderHome() {
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
      if (err.status === 404) forgetTrip(code);
      $app.innerHTML = `<div class="screen"><div class="card"><h2>Trip not found</h2><p>${h(err.message)}. The link may be wrong or the trip was deleted.</p><a class="btn" data-nav href="/">Go home</a></div></div>`;
      return;
    }
    const rec = loadTrips()[code];
    if (!rec) return renderJoin(code, info.trip);
    // Validate the stored token still works (trip may have been wiped server-side).
    try { const me = await api('GET', `/api/trips/${code}/me`, { token: rec.token }); saveTrip(code, { isOwner: me.member.isOwner, tripName: me.trip.name, name: me.member.name }); }
    catch (err) { if (err.status === 401) { forgetTrip(code); return renderJoin(code, info.trip); } }
    return renderTripApp(code, loadTrips()[code], info.trip);
  }

  function renderJoin(code, trip) {
    $app.innerHTML = `
      <div class="screen">
        <div class="hero">
          <img class="logo" src="/icon.svg" alt="">
          <h1>${h(trip.name)}</h1>
          <p>${trip.memberCount} ${trip.memberCount === 1 ? 'person' : 'people'} · ${trip.photoCount} photos so far</p>
        </div>
        <form class="card" id="join">
          <h2>Join this trip</h2>
          <p>Your name is shown next to the photos you add. Nothing else is collected.</p>
          <label for="name">Your name</label>
          <input type="text" id="name" required maxlength="60" value="${h(savedName())}" autocomplete="name" placeholder="Your name">
          <button class="btn primary block" type="submit">Join &amp; open camera</button>
        </form>
        <p class="muted" style="text-align:center">You can add this page to your home screen later to use it like an app.</p>
      </div>`;
    $app.querySelector('#join').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = $app.querySelector('#name').value.trim();
      const btn = e.target.querySelector('button'); btn.disabled = true;
      try {
        localStorage.setItem(LS_NAME, name);
        const { member, trip: t } = await api('POST', `/api/trips/${code}/join`, { json: { name } });
        saveTrip(code, { token: member.token, memberId: member.id, name: member.name, tripName: t.name, isOwner: false, joinedAt: Date.now() });
        render();
      } catch (err) { toast(err.message, true); btn.disabled = false; }
    });
  }

  function renderTripApp(code, rec, trip) {
    const params = new URLSearchParams(location.search);
    let tab = params.get('tab') || 'camera';
    const cleanups = [];
    teardown = () => cleanups.splice(0).forEach((fn) => fn());

    $app.innerHTML = `
      <div class="screen with-tabs">
        <div class="trip-header">
          <div><h1>${h(trip.name)}</h1><div class="muted" id="hdr-stats">${trip.memberCount} ${trip.memberCount === 1 ? 'person' : 'people'} · ${trip.photoCount} photo${trip.photoCount === 1 ? '' : 's'}</div></div>
          <a data-nav href="/">All trips</a>
        </div>
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
      const n = (await qAll()).filter((i) => i.code === code).length;
      $badge.hidden = n === 0; $badge.textContent = n;
    }
    async function refreshHeader() {
      try {
        const { trip: t } = await api('GET', `/api/trips/${code}`);
        $app.querySelector('#hdr-stats').textContent = `${t.memberCount} ${t.memberCount === 1 ? 'person' : 'people'} · ${t.photoCount} photo${t.photoCount === 1 ? '' : 's'} · ${fmtBytes(t.totalBytes)}`;
      } catch { /* offline: keep last known */ }
    }
    cleanups.push(onSync((ev) => { refreshBadge(); if (ev.type === 'done') refreshHeader(); }));
    refreshBadge();
    refreshHeader();
    const hdrTimer = setInterval(() => { if (!document.hidden) refreshHeader(); }, 30000);
    cleanups.push(() => clearInterval(hdrTimer));

    function showTab(name) {
      tab = name;
      history.replaceState({}, '', `/t/${code}${name === 'camera' ? '' : `?tab=${name}`}`);
      $app.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
      if (tabCleanup) { tabCleanup(); tabCleanup = null; }
      $body.innerHTML = '';
      if (name === 'camera') tabCleanup = tabCamera($body, code, rec);
      else if (name === 'photos') tabCleanup = tabPhotos($body, code, rec);
      else tabCleanup = tabShare($body, code, rec, trip);
    }
    cleanups.push(() => tabCleanup && tabCleanup());
    $app.querySelector('#tabs').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-tab]'); if (b) showTab(b.dataset.tab);
    });
    showTab(tab);
  }

  // ---------------------------------------------------------------- camera
  function tabCamera($el, code, rec) {
    $el.innerHTML = `
      <div class="camera" id="cam">
        <video id="video" autoplay playsinline muted></video>
        <div class="flash" id="flash"></div>
        <div class="cam-msg" id="cam-msg" hidden></div>
      </div>
      <div class="cam-controls">
        <img class="last-shot" id="last" alt="" hidden>
        <button class="icon-btn" id="last-ph" aria-hidden="true" style="visibility:hidden"></button>
        <button class="shutter" id="shutter" aria-label="Take photo"></button>
        <button class="icon-btn" id="flip" title="Switch camera" aria-label="Switch camera">🔄</button>
      </div>
      <div class="upload-status" id="status"></div>
      <div class="file-fallback">
        <label class="btn small" for="file">➕ Add from gallery / system camera</label>
        <input type="file" id="file" accept="image/*" multiple>
      </div>`;
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
      facing = facing === 'environment' ? 'user' : 'environment';
      localStorage.setItem('triplink:facing', facing);
      start();
    });
    $el.querySelector('#file').addEventListener('change', async (e) => {
      const files = [...e.target.files];
      e.target.value = '';
      let n = 0;
      for (const f of files) {
        try { const t = await enqueueFile(code, f); if (t) showLast(t); n++; }
        catch (err) { toast(`Skipped ${f.name}: ${err.message}`, true); }
      }
      if (n) toast(`${n} photo${n > 1 ? 's' : ''} added to the trip`);
    });

    const unsub = onSync(async (ev) => {
      const n = (await qAll()).filter((i) => i.code === code).length;
      if (ev.type === 'start') $status.textContent = `Uploading… ${n} left`;
      else if (ev.type === 'done') $status.textContent = n ? `Uploaded. ${n} left` : 'All photos are in the trip ✓';
      else if (ev.type === 'offline') $status.textContent = `Offline – ${n} photo${n > 1 ? 's' : ''} saved, will upload when back online`;
      else if (ev.type === 'failed') { $status.textContent = `A photo was rejected: ${ev.error}`; toast(ev.error, true); }
      else if (ev.type === 'idle' && !n) setTimeout(() => { if (!$status.textContent.includes('rejected')) $status.textContent = ''; }, 2500);
    });
    qAll().then((items) => { const n = items.filter((i) => i.code === code).length; if (n) { $status.textContent = `${n} photo${n > 1 ? 's' : ''} waiting to upload`; syncQueue(); } });

    const onVis = () => { if (document.hidden) stop(); else if (!stream) start(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { stop(); unsub(); document.removeEventListener('visibilitychange', onVis); };
  }

  // ---------------------------------------------------------------- photos
  function tabPhotos($el, code, rec) {
    $el.innerHTML = `
      <div class="row between" style="margin:6px 0 4px">
        <span class="muted" id="count"></span>
        <div class="row">
          <button class="btn small" id="refresh">↻</button>
          <a class="btn small primary" id="zip" href="/api/trips/${code}/download.zip" download>⬇ Download all</a>
        </div>
      </div>
      <div class="grid" id="grid"></div>
      <div class="empty" id="empty" hidden>No photos yet. Take the first one!</div>`;
    const $grid = $el.querySelector('#grid');
    let photos = [];
    let timer;

    // The zip needs the member token; anchors cannot send headers, so fetch it and hand the blob to the browser.
    $el.querySelector('#zip').addEventListener('click', async (e) => {
      e.preventDefault();
      if (!photos.length) return toast('No photos to download yet', true);
      const a = e.currentTarget; a.textContent = 'Preparing zip…';
      try {
        const res = await fetch(`/api/trips/${code}/download.zip`, { headers: { 'X-Member-Token': rec.token } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const dl = document.createElement('a'); dl.href = url; dl.download = (res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'trip_photos.zip';
        document.body.appendChild(dl); dl.click(); dl.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      } catch (err) { toast(`Download failed: ${err.message}`, true); }
      finally { a.textContent = '⬇ Download all'; }
    });

    async function load() {
      try {
        const [{ photos: list }, queued] = await Promise.all([api('GET', `/api/trips/${code}/photos`, { token: rec.token }), qAll()]);
        photos = list;
        const pending = queued.filter((i) => i.code === code);
        $el.querySelector('#count').textContent = `${list.length} photo${list.length === 1 ? '' : 's'}${pending.length ? ` · ${pending.length} uploading` : ''}`;
        $el.querySelector('#empty').hidden = list.length + pending.length > 0;
        $grid.innerHTML = pending.map((p) => `<button disabled><img src="${p.thumb ? URL.createObjectURL(p.thumb) : ''}" alt=""><div class="pending">uploading…</div></button>`).join('')
          + list.map((p, i) => `<button data-i="${i}"><img loading="lazy" src="${p.thumbUrl}" alt="Photo by ${h(p.memberName)}"><span class="who">${h(p.memberName)}</span></button>`).join('');
      } catch (err) { toast(err.message, true); }
    }
    $grid.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-i]'); if (b) openLightbox(Number(b.dataset.i));
    });
    $el.querySelector('#refresh').addEventListener('click', load);

    function openLightbox(i) {
      const p = photos[i]; if (!p) return;
      const mine = p.memberId === rec.memberId;
      const $lb = document.createElement('div');
      $lb.className = 'lightbox';
      $lb.innerHTML = `
        <div class="bar"><span class="meta">${h(p.memberName)} · ${fmtTime(p.takenAt || p.createdAt)} · ${fmtBytes(p.size)}</span><button class="btn small" id="close">✕</button></div>
        <img src="${p.url}" alt="">
        <div class="bar bottom">
          <button class="btn small" id="prev" ${i >= photos.length - 1 ? 'disabled' : ''}>‹ Older</button>
          <a class="btn small primary" href="${p.url}?download=1" download>⬇ Save</a>
          ${(mine || rec.isOwner) ? '<button class="btn small danger" id="del">Delete</button>' : ''}
          <button class="btn small" id="next" ${i <= 0 ? 'disabled' : ''}>Newer ›</button>
        </div>`;
      document.body.appendChild($lb);
      const close = () => $lb.remove();
      $lb.querySelector('#close').onclick = close;
      $lb.querySelector('#prev').onclick = () => { close(); openLightbox(i + 1); };
      $lb.querySelector('#next').onclick = () => { close(); openLightbox(i - 1); };
      const $del = $lb.querySelector('#del');
      if ($del) $del.onclick = async () => {
        if (!confirm('Delete this photo for everyone in the trip?')) return;
        try { await api('DELETE', `/api/trips/${code}/photos/${p.id}`, { token: rec.token }); close(); toast('Photo deleted'); load(); }
        catch (err) { toast(err.message, true); }
      };
      const onKey = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
      document.addEventListener('keydown', onKey);
    }

    load();
    const unsub = onSync((ev) => { if (ev.type === 'done' || ev.type === 'failed') load(); });
    timer = setInterval(() => { if (!document.hidden) load(); }, 15000);
    return () => { clearInterval(timer); unsub(); };
  }

  // ----------------------------------------------------------------- share
  let deferredInstall = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; });

  function tabShare($el, code, rec, trip) {
    const link = `${location.origin}/t/${code}`;
    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
    const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    $el.innerHTML = `
      <div class="card">
        <h2>Invite everyone</h2>
        <p>Anyone who opens this link joins the trip and their photos land here. No account needed.</p>
        <div class="linkbox"><input type="text" id="link" readonly value="${h(link)}"><button class="btn" id="copy">Copy</button></div>
        <button class="btn primary block" id="share">📤 Share link (WhatsApp, Messages, …)</button>
        <p class="muted" style="margin-top:10px">Tip: read the code out loud at dinner – it is <b>${h(code)}</b>. People can type it on the home page.</p>
      </div>
      ${!standalone ? `
      <div class="card install-hint">
        <h2>Use it like an app</h2>
        ${deferredInstall ? '<button class="btn block" id="install">📲 Add to home screen</button>'
          : isIOS ? '<p>On iPhone: tap the <b>Share</b> button in Safari, then <b>Add to Home Screen</b>. You get a full-screen camera with an icon.</p>'
          : '<p>Open the browser menu and choose <b>Add to Home Screen</b> / <b>Install app</b>.</p>'}
      </div>` : ''}
      <div class="card">
        <h2>Who is in</h2>
        <ul class="list" id="members"><li class="muted">Loading…</li></ul>
      </div>
      <div class="card">
        <h2>Everyone gets everything</h2>
        <p>Open <b>Photos → Download all</b> to get a single .zip of every photo from every phone, named by time and person.</p>
        <button class="btn danger small" id="leave">Leave trip on this device</button>
      </div>`;
    $el.querySelector('#copy').onclick = async () => {
      try { await navigator.clipboard.writeText(link); toast('Link copied'); }
      catch { $el.querySelector('#link').select(); document.execCommand('copy'); toast('Link copied'); }
    };
    $el.querySelector('#share').onclick = async () => {
      const text = `Join "${trip.name}" on TripLink and add your photos: ${link}`;
      if (navigator.share) { try { await navigator.share({ title: trip.name, text, url: link }); } catch { /* cancelled */ } }
      else { await navigator.clipboard.writeText(text).catch(() => {}); toast('Message copied – paste it in your group chat'); }
    };
    const $install = $el.querySelector('#install');
    if ($install) $install.onclick = async () => { deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null; $install.remove(); };
    $el.querySelector('#leave').onclick = () => { if (confirm('Remove this trip from this device? Your uploaded photos stay in the trip.')) { forgetTrip(code); navigate('/'); } };
    api('GET', `/api/trips/${code}/members`, { token: rec.token }).then(({ members }) => {
      $el.querySelector('#members').innerHTML = members.map((m) => `<li><span>${h(m.name)}${m.isOwner ? ' <span class="pill">owner</span>' : ''}${m.id === rec.memberId ? ' <span class="pill ok">you</span>' : ''}</span><span class="muted">${m.photoCount} photos</span></li>`).join('') || '<li class="muted">Nobody yet</li>';
    }).catch((err) => toast(err.message, true));
    return () => {};
  }

  // ------------------------------------------------------------------ boot
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  render();
  syncQueue();
})();
