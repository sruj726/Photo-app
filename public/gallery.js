/* TripLink gallery (Photos tab): day sections, filters, virtualised grid, hearts, comments, lightbox, export.
 * Loaded before app.js; app.js calls window.TripLinkGallery(TL) with its shared helpers. */
window.TripLinkGallery = function (TL) {
  'use strict';
  const { api, toast, h, fmtBytes, fmtTime, keptUntil, qAll, qAdd, onSync, syncQueue, isIOS, $app } = TL;

  const HEADER_H = 38;      // day header row height (px)
  const GAP = 3;
  const BUFFER_ROWS = 4;    // rows rendered above/below the viewport
  const dayKey = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const dayLabel = (key) => {
    const [y, m, d] = key.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    const today = dayKey(Date.now()), yesterday = dayKey(Date.now() - 86400000);
    if (key === today) return 'Today';
    if (key === yesterday) return 'Yesterday';
    return date.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: y === new Date().getFullYear() ? undefined : 'numeric' });
  };
  const fmtDur = (s) => (s ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : '');

  /** Fetch the zip with the member token and hand it to the browser as a download. */
  async function zipDownload(code, rec, { favourites = false } = {}) {
    const res = await fetch(`/api/trips/${code}/download.zip${favourites ? '?favourites=1' : ''}`, { headers: { 'X-Member-Token': rec.token } });
    if (!res.ok) { let msg = `HTTP ${res.status}`; try { msg = (await res.json()).error || msg; } catch { /* keep */ } throw new Error(msg); }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const dl = document.createElement('a');
    dl.href = url; dl.download = (res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'trip_photos.zip';
    document.body.appendChild(dl); dl.click(); dl.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function tabPhotos($el, code, rec, trip) {
    $el.innerHTML = `
      <div class="row between" style="margin:6px 0 4px">
        <span class="muted" id="count"></span>
        <div class="row">
          <button class="btn small" id="refresh" title="Refresh">↻</button>
          <button class="btn small" id="export" title="Export">⋯</button>
          <a class="btn small primary" id="zip" href="/api/trips/${code}/download.zip" download>⬇ Download all</a>
        </div>
      </div>
      <div class="muted" id="retention" style="font-size:13px;margin-bottom:4px">${h(keptUntil(trip))}</div>
      <div class="nudge" id="reciprocity" hidden></div>
      <div class="chips" id="chips"></div>
      <div class="grid-v" id="grid"></div>
      <div class="empty" id="empty" hidden>No photos yet. Take the first one!</div>`;
    const $grid = $el.querySelector('#grid');
    const $chips = $el.querySelector('#chips');
    let photos = [];          // full list from the server (newest first)
    let pending = [];         // queued uploads for this trip
    let filter = { type: 'all' };   // {type:'all'|'fav'|'video'|'member'|'reported'|'people'|'me', id}
    let expandBursts = false;       // ai.bestShot: bursts collapse to their sharpest shot unless expanded
    let meMatches = null;           // ai.faces: Set of photo ids matching the selfie (null = not run yet)
    const ai = (trip && trip.ai) || {};
    let visible = [];         // filtered photos
    let rows = [];            // virtual rows: {type:'header', label, n} | {type:'row', items}
    let cols = 3, tile = 100, offsets = [];
    let renderedRange = [-1, -1];

    $el.querySelector('#zip').addEventListener('click', async (e) => {
      e.preventDefault();
      if (!photos.length) return toast('No photos to download yet', true);
      const a = e.currentTarget; a.textContent = 'Preparing zip…';
      try { await zipDownload(code, rec); } catch (err) { toast(`Download failed: ${err.message}`, true); }
      finally { a.textContent = '⬇ Download all'; }
    });
    $el.querySelector('#export').onclick = () => openExport();
    $el.querySelector('#refresh').onclick = () => load();

    // ------------------------------------------------------------ data
    function applyFilter() {
      let base = photos.filter((p) => {
        if (filter.type === 'reported') return p.reportCount > 0;
        if (p.reportedByMe) return false;               // hidden for the person who reported it
        if (filter.type === 'fav') return p.favourited;
        if (filter.type === 'video') return p.kind === 'video';
        if (filter.type === 'member') return p.memberId === filter.id;
        if (filter.type === 'people') return (p.peopleCount || 0) >= 3;
        if (filter.type === 'me') return !!(meMatches && meMatches.has(p.id));
        return true;
      });
      // Best shot: collapse bursts (same person, within 3 s) to their sharpest frame.
      for (const p of base) delete p.burst;
      if (ai.bestShot && !expandBursts && filter.type !== 'reported') {
        base = window.TLQuality.groupBursts(base, 3000).map((g) => { if (g.items.length > 1) g.best.burst = g.items.length; return g.best; });
      }
      visible = base;
      buildRows();
      renderChips();
      renderedRange = [-1, -1];
      renderWindow(true);
    }
    function buildRows() {
      const w = $grid.clientWidth || $el.clientWidth || 360;
      cols = w >= 560 ? 4 : 3;
      tile = Math.floor((w - GAP * (cols - 1)) / cols);
      rows = [];
      const list = [...pending.map((p) => ({ pending: true, ...p })), ...visible];
      let day = null, bucket = [];
      const flush = () => { for (let i = 0; i < bucket.length; i += cols) rows.push({ type: 'row', items: bucket.slice(i, i + cols) }); bucket = []; };
      for (const p of list) {
        const k = dayKey(p.takenAt || p.createdAt || p.addedAt || Date.now());
        if (k !== day) { flush(); day = k; rows.push({ type: 'header', label: dayLabel(k), key: k, n: list.filter((x) => dayKey(x.takenAt || x.createdAt || x.addedAt || Date.now()) === k).length }); }
        bucket.push(p);
      }
      flush();
      offsets = [0];
      for (const r of rows) offsets.push(offsets[offsets.length - 1] + (r.type === 'header' ? HEADER_H : tile + GAP));
      $grid.style.minHeight = `${offsets[offsets.length - 1]}px`;
    }
    function renderChips() {
      const shown = photos.filter((p) => !p.reportedByMe);
      const byMember = new Map();
      for (const p of shown) byMember.set(p.memberId, { name: p.memberName, n: (byMember.get(p.memberId) || { n: 0 }).n + 1 });
      const favs = shown.filter((p) => p.favourited).length, vids = shown.filter((p) => p.kind === 'video').length;
      const reported = rec.isOrganiser ? photos.filter((p) => p.reportCount > 0).length : 0;
      const chip = (f, label, active) => `<button class="chip ${active ? 'active' : ''}" data-f='${h(JSON.stringify(f))}'>${label}</button>`;
      const groups = ai.people ? shown.filter((p) => (p.peopleCount || 0) >= 3).length : 0;
      const me = ai.faces ? (meMatches ? shown.filter((p) => meMatches.has(p.id)).length : null) : undefined;
      const hasLoc = ai.map && shown.some((p) => p.lat != null);
      const bursts = ai.bestShot && window.TLQuality.groupBursts(shown, 3000).some((g) => g.items.length > 1);
      $chips.innerHTML = chip({ type: 'all' }, `All ${shown.length}`, filter.type === 'all')
        + (favs ? chip({ type: 'fav' }, `♥ Favourites ${favs}`, filter.type === 'fav') : '')
        + (vids ? chip({ type: 'video' }, `🎥 Videos ${vids}`, filter.type === 'video') : '')
        + (reported ? chip({ type: 'reported' }, `🚩 Reported ${reported}`, filter.type === 'reported') : '')
        + (groups ? chip({ type: 'people' }, `👥 Group photos ${groups}`, filter.type === 'people') : '')
        + (me !== undefined ? `<button class="chip ${filter.type === 'me' ? 'active' : ''}" id="chip-me" data-f='${h(JSON.stringify({ type: 'me' }))}'>🙂 Me${me === null ? '' : ` ${me}`}</button>` : '')
        + (hasLoc ? '<button class="chip" id="chip-map">🗺 Map</button>' : '')
        + (bursts ? `<button class="chip ${expandBursts ? 'active' : ''}" id="chip-bursts">${expandBursts ? '⧉ Bursts expanded' : '⧉ Show all shots'}</button>` : '')
        + [...byMember.entries()].sort((a, b) => b[1].n - a[1].n).map(([id, m]) => chip({ type: 'member', id }, `${h(m.name)} ${m.n}`, filter.type === 'member' && filter.id === id)).join('');
    }
    $chips.addEventListener('click', (e) => {
      const b = e.target.closest('.chip'); if (!b) return;
      if (b.id === 'chip-map') return openMap();
      if (b.id === 'chip-bursts') { expandBursts = !expandBursts; applyFilter(); return; }
      if (b.id === 'chip-me' && meMatches === null) return findMe();
      filter = JSON.parse(b.dataset.f);
      applyFilter();
      window.scrollTo({ top: Math.max(0, $grid.getBoundingClientRect().top + window.scrollY - 60) });
    });

    // ------------------------------------------------------------ virtualised rendering (window scroll + spacers)
    function rowIndexAt(y) { let lo = 0, hi = rows.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (offsets[mid] <= y) lo = mid; else hi = mid - 1; } return lo; }
    function tileHtml(p) {
      if (p.pending) return `<div class="vtile" style="width:${tile}px;height:${tile}px"><button disabled><img src="${p.thumb ? URL.createObjectURL(p.thumb) : ''}" alt=""><div class="pending">${p.kind === 'video' ? 'video ' : ''}uploading…</div></button></div>`;
      return `<div class="vtile" style="width:${tile}px;height:${tile}px"><button data-id="${p.id}">
          ${p.thumbUrl ? `<img loading="lazy" src="${p.thumbUrl}" alt="${p.kind === 'video' ? 'Video' : 'Photo'} by ${h(p.memberName)}">` : '<div class="tile-video"></div>'}
          ${p.kind === 'video' ? `<span class="play">▶ ${fmtDur(p.duration)}</span>` : ''}
          ${p.hearts ? `<span class="hearts ${p.favourited ? 'mine' : ''}">♥ ${p.hearts}</span>` : ''}
          ${p.burst ? `<span class="stack" title="${p.burst} shots, sharpest shown">⧉ +${p.burst - 1}</span>` : ''}
          ${(p.peopleCount || 0) >= 3 ? `<span class="ppl">👥 ${p.peopleCount}</span>` : ''}
          ${p.commentCount ? `<span class="cmts">💬 ${p.commentCount}</span>` : ''}
          <span class="who">${h(p.memberName)}</span></button></div>`;
    }
    function renderWindow(force) {
      if (!rows.length) { $grid.innerHTML = ''; $el.querySelector('#empty').hidden = photos.length + pending.length > 0; return; }
      $el.querySelector('#empty').hidden = true;
      const top = $grid.getBoundingClientRect().top + window.scrollY;
      const y0 = Math.max(0, window.scrollY - top), y1 = y0 + window.innerHeight;
      let first = Math.max(0, rowIndexAt(y0) - BUFFER_ROWS), last = Math.min(rows.length - 1, rowIndexAt(y1) + BUFFER_ROWS);
      // Keep the header of the first visible day so it stays sticky.
      while (first > 0 && rows[first].type !== 'header') first--;
      if (!force && first === renderedRange[0] && last === renderedRange[1]) return;
      renderedRange = [first, last];
      let html = `<div class="vspace" style="height:${offsets[first]}px"></div>`;
      for (let i = first; i <= last; i++) {
        const r = rows[i];
        html += r.type === 'header' ? `<div class="day-head" style="height:${HEADER_H}px">${h(r.label)}<span class="muted"> · ${r.n}</span></div>`
          : `<div class="vrow" style="height:${tile + GAP}px;gap:${GAP}px">${r.items.map(tileHtml).join('')}</div>`;
      }
      html += `<div class="vspace" style="height:${offsets[offsets.length - 1] - offsets[last + 1]}px"></div>`;
      $grid.innerHTML = html;
    }
    let raf = 0;
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; renderWindow(false); }); };
    const onResize = () => { buildRows(); renderedRange = [-1, -1]; renderWindow(true); };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize);

    async function load() {
      try {
        const [{ photos: list }, queued] = await Promise.all([api('GET', `/api/trips/${code}/photos`, { token: rec.token }), qAll()]);
        photos = list;
        pending = queued.filter((i) => i.code === code && i.kind !== 'comment');
        $el.querySelector('#count').textContent = `${list.length} photo${list.length === 1 ? '' : 's'}${pending.length ? ` · ${pending.length} uploading` : ''}`;
        applyFilter();
        // Reciprocity: "You added 0 · Priya 32" – the gentlest nudge there is.
        const counts = new Map();
        for (const p of list) counts.set(p.memberId, { name: p.memberName, n: (counts.get(p.memberId) || { n: 0 }).n + 1 });
        const mine = (counts.get(rec.memberId) || { n: 0 }).n + pending.length;
        const top = [...counts.entries()].filter(([id]) => id !== rec.memberId).sort((a, b) => b[1].n - a[1].n)[0];
        const $r = $el.querySelector('#reciprocity');
        if (top && mine < top[1].n) {
          $r.hidden = false;
          $r.innerHTML = `<span>You added <b>${mine}</b> · ${h(top[1].name)} <b>${top[1].n}</b></span><button class="btn small primary" id="to-camera">📷 Add yours</button>`;
          $r.querySelector('#to-camera').onclick = () => $app.querySelector('#tabs button[data-tab=camera]').click();
        } else $r.hidden = true;
      } catch (err) { toast(err.message, true); }
    }
    $grid.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-id]'); if (!b) return;
      const i = visible.findIndex((p) => p.id === b.dataset.id);
      if (i >= 0) openLightbox(i);
    });

    // ------------------------------------------------------------ hearts + comments
    async function toggleHeart(p) {
      const on = !p.favourited;
      p.favourited = on; p.hearts += on ? 1 : -1;            // optimistic
      try {
        const r = await api(on ? 'POST' : 'DELETE', `/api/trips/${code}/photos/${p.id}/favourite`, { token: rec.token });
        p.favourited = r.favourited; p.hearts = r.hearts;
      } catch (err) { p.favourited = !on; p.hearts += on ? -1 : 1; toast(navigator.onLine ? err.message : 'You are offline – try again later', true); }
      renderedRange = [-1, -1]; renderWindow(true);
      return p;
    }

    // ------------------------------------------------------------ lightbox
    let $lb = null, lbIndex = -1, lbKeyHandler = null;
    function preload(i) { const p = visible[i]; if (p && p.kind !== 'video') { const im = new Image(); im.src = p.url; } }
    function openLightbox(i) {
      closeLightbox();
      const p = visible[i]; if (!p) return;
      lbIndex = i;
      const mine = p.memberId === rec.memberId;
      $lb = document.createElement('div');
      $lb.className = 'lightbox';
      $lb.innerHTML = `
        <div class="bar"><span class="meta">${h(p.memberName)} · ${fmtTime(p.takenAt || p.createdAt)} · ${fmtBytes(p.size)}${p.kind === 'video' && p.duration ? ` · ${Math.round(p.duration)}s` : ''}</span><button class="btn small" id="close">✕</button></div>
        <div class="stage" id="stage">
          ${p.kind === 'video' ? `<video src="${p.url}" controls playsinline autoplay ${p.thumbUrl ? `poster="${p.thumbUrl}"` : ''}></video>` : `<img src="${p.url}" alt="" draggable="false">`}
        </div>
        <div class="bar bottom">
          <button class="btn small" id="prev" ${i >= visible.length - 1 ? 'disabled' : ''}>‹</button>
          <button class="btn small heart ${p.favourited ? 'on' : ''}" id="heart">♥ <span id="heart-n">${p.hearts || ''}</span></button>
          ${trip.commentsEnabled === false ? '' : `<button class="btn small" id="comments">💬 <span id="cmt-n">${p.commentCount || ''}</span></button>`}
          <a class="btn small primary" href="${p.url}?download=1" download>⬇</a>
          ${p.originalUrl ? `<a class="btn small" id="save-original" href="${p.originalUrl}?download=1" download title="Untouched file">Original${p.originalSize ? ` (${fmtBytes(p.originalSize)})` : ''}</a>` : ''}
          ${!mine ? '<button class="btn small" id="report" title="Report this photo">🚩</button>' : ''}
          ${rec.isOrganiser && p.reportCount ? `<button class="btn small" id="dismiss-reports" title="Keep the photo, clear the reports">Keep (${p.reportCount} 🚩)</button>` : ''}
          ${(mine || rec.isOrganiser) ? '<button class="btn small danger" id="del">Delete</button>' : ''}
          <button class="btn small" id="next" ${i <= 0 ? 'disabled' : ''}>›</button>
        </div>
        <div class="cpanel" id="cpanel" hidden>
          <div class="clist" id="clist"><div class="muted">Loading…</div></div>
          <form class="cform" id="cform"><input type="text" id="ctext" maxlength="280" placeholder="Say something…" autocomplete="off"><button class="btn small primary" type="submit">Send</button></form>
        </div>`;
      document.body.appendChild($lb);
      $lb.querySelector('#close').onclick = closeLightbox;
      $lb.querySelector('#prev').onclick = () => openLightbox(i + 1);
      $lb.querySelector('#next').onclick = () => openLightbox(i - 1);
      $lb.querySelector('#heart').onclick = async () => {
        const np = await toggleHeart(p);
        $lb.querySelector('#heart').classList.toggle('on', np.favourited);
        $lb.querySelector('#heart-n').textContent = np.hearts || '';
        renderChips();
      };
      const $cm = $lb.querySelector('#comments');
      if ($cm) $cm.onclick = () => { const cp = $lb.querySelector('#cpanel'); cp.hidden = !cp.hidden; if (!cp.hidden) loadComments(p); };
      const $report = $lb.querySelector('#report');
      if ($report) $report.onclick = async () => {
        const reason = prompt('Why are you reporting this photo? (optional)', '') ;
        if (reason === null) return;
        try {
          await api('POST', `/api/trips/${code}/photos/${p.id}/report`, { token: rec.token, json: { reason } });
          p.reportedByMe = true; p.reportCount += 1;
          closeLightbox(); toast('Reported – hidden for you, the organiser will review it'); applyFilter();
        } catch (err) { toast(err.message, true); }
      };
      const $dismiss = $lb.querySelector('#dismiss-reports');
      if ($dismiss) $dismiss.onclick = async () => {
        try { await api('DELETE', `/api/trips/${code}/photos/${p.id}/reports`, { token: rec.token }); toast('Reports cleared'); closeLightbox(); load(); }
        catch (err) { toast(err.message, true); }
      };
      const $del = $lb.querySelector('#del');
      if ($del) $del.onclick = async () => {
        if (!confirm('Delete this for everyone in the trip?')) return;
        try { await api('DELETE', `/api/trips/${code}/photos/${p.id}`, { token: rec.token }); closeLightbox(); toast('Deleted'); load(); }
        catch (err) { toast(err.message, true); }
      };
      $lb.querySelector('#cform').addEventListener('submit', async (e) => {
        e.preventDefault();
        const $t = $lb.querySelector('#ctext'); const text = $t.value.trim(); if (!text) return;
        $t.value = '';
        try {
          if (!navigator.onLine) throw Object.assign(new Error('offline'), { offline: true });
          const { comment } = await api('POST', `/api/trips/${code}/photos/${p.id}/comments`, { token: rec.token, json: { text } });
          p.commentCount += 1; $lb.querySelector('#cmt-n').textContent = p.commentCount;
          appendComment(comment, p);
        } catch (err) {
          if (err.offline || !err.status) {
            // Offline: queue it; the upload loop posts it when the network is back.
            await qAdd({ code, kind: 'comment', photoId: p.id, text, addedAt: Date.now() });
            appendComment({ text, memberName: rec.name, createdAt: Date.now(), pending: true }, p);
            toast('Saved – will post when you are back online');
            syncQueue();
          } else toast(err.message, true);
        }
      });
      lbKeyHandler = (e) => {
        if (e.key === 'Escape') closeLightbox();
        else if (e.key === 'ArrowLeft' && i < visible.length - 1) openLightbox(i + 1);
        else if (e.key === 'ArrowRight' && i > 0) openLightbox(i - 1);
      };
      document.addEventListener('keydown', lbKeyHandler);
      installGestures($lb.querySelector('#stage'), i);
      preload(i + 1); preload(i - 1);
    }
    function closeLightbox() {
      if ($lb) { $lb.remove(); $lb = null; }
      if (lbKeyHandler) { document.removeEventListener('keydown', lbKeyHandler); lbKeyHandler = null; }
      lbIndex = -1;
    }
    function appendComment(c, p) {
      const $l = $lb && $lb.querySelector('#clist'); if (!$l) return;
      if ($l.querySelector('.muted')) $l.innerHTML = '';
      const mine = c.memberId === rec.memberId || c.pending;
      $l.insertAdjacentHTML('beforeend', `<div class="cmt ${c.pending ? 'pending' : ''}" data-id="${c.id || ''}"><b>${h(c.memberName)}</b> ${h(c.text)} <span class="muted">${c.pending ? '· sending…' : fmtTime(c.createdAt)}</span>${(mine || rec.isOrganiser) && c.id ? ` <button class="cmt-del" data-id="${c.id}" title="Delete">✕</button>` : ''}</div>`);
      $l.scrollTop = $l.scrollHeight;
      $l.querySelectorAll('.cmt-del').forEach((b) => { b.onclick = async () => {
        try { await api('DELETE', `/api/trips/${code}/photos/${p.id}/comments/${b.dataset.id}`, { token: rec.token }); b.closest('.cmt').remove(); p.commentCount = Math.max(0, p.commentCount - 1); $lb.querySelector('#cmt-n').textContent = p.commentCount || ''; }
        catch (err) { toast(err.message, true); }
      }; });
    }
    async function loadComments(p) {
      const $l = $lb.querySelector('#clist');
      try {
        const { comments } = await api('GET', `/api/trips/${code}/photos/${p.id}/comments`, { token: rec.token });
        $l.innerHTML = comments.length ? '' : '<div class="muted">No comments yet.</div>';
        for (const c of comments) appendComment(c, p);
        const queued = (await qAll()).filter((i) => i.kind === 'comment' && i.photoId === p.id);
        for (const qc of queued) appendComment({ text: qc.text, memberName: rec.name, pending: true }, p);
      } catch (err) { $l.innerHTML = `<div class="muted">${h(err.message)}</div>`; }
    }

    /** Swipe to navigate, pinch to zoom, double-tap to toggle 2x. Pointer events, no library. */
    function installGestures($stage, i) {
      const $media = $stage.querySelector('img, video');
      if (!$media) return;
      const pointers = new Map();
      let scale = 1, tx = 0, ty = 0, startDist = 0, startScale = 1, panStart = null, lastTap = 0, swipeStart = null;
      const apply = () => { $media.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`; };
      const reset = () => { scale = 1; tx = 0; ty = 0; apply(); };
      $stage.style.touchAction = 'none';
      $stage.addEventListener('pointerdown', (e) => {
        if ($media.tagName === 'VIDEO' && e.target === $media && scale === 1) return;   // let the video controls work
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        $stage.setPointerCapture(e.pointerId);
        if (pointers.size === 2) {
          const [a, b] = [...pointers.values()];
          startDist = Math.hypot(a.x - b.x, a.y - b.y); startScale = scale; swipeStart = null;
        } else if (pointers.size === 1) {
          swipeStart = scale === 1 ? { x: e.clientX, y: e.clientY, t: Date.now() } : null;
          panStart = { x: e.clientX - tx, y: e.clientY - ty };
        }
      });
      $stage.addEventListener('pointermove', (e) => {
        if (!pointers.has(e.pointerId)) return;
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pointers.size === 2) {
          const [a, b] = [...pointers.values()];
          scale = Math.min(5, Math.max(1, startScale * (Math.hypot(a.x - b.x, a.y - b.y) / startDist)));
          if (scale === 1) { tx = 0; ty = 0; }
          apply();
        } else if (scale > 1 && panStart) { tx = e.clientX - panStart.x; ty = e.clientY - panStart.y; apply(); }
      });
      const up = (e) => {
        pointers.delete(e.pointerId);
        if (swipeStart && scale === 1 && pointers.size === 0) {
          const dx = e.clientX - swipeStart.x, dy = e.clientY - swipeStart.y, dt = Date.now() - swipeStart.t;
          if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5 && dt < 800) {
            if (dx < 0 && i > 0) openLightbox(i - 1);            // swipe left -> newer
            else if (dx > 0 && i < visible.length - 1) openLightbox(i + 1);   // swipe right -> older
            return;
          }
          if (Math.abs(dx) < 8 && Math.abs(dy) < 8 && dt < 300) {
            const t = Date.now();
            if (t - lastTap < 300) { if (scale > 1) reset(); else { scale = 2; apply(); } lastTap = 0; } else lastTap = t;
          }
        }
        swipeStart = null;
      };
      $stage.addEventListener('pointerup', up);
      $stage.addEventListener('pointercancel', up);
    }

    // ------------------------------------------------------------ map (opt-in, tiles fetched only when opened)
    function openMap() {
      const G = window.TLGeo;
      const pts = photos.filter((p) => p.lat != null && !p.reportedByMe);
      if (!pts.length) return toast('No photos with a location yet', true);
      const sheet = document.createElement('div');
      sheet.className = 'sheet'; sheet.id = 'map-view';
      sheet.innerHTML = `<div class="sheet-body map-body">
        <div class="row between"><h2>Where the photos were taken</h2><button class="btn small" id="map-close">✕</button></div>
        <div class="map" id="map"><canvas id="map-canvas"></canvas><div id="map-pins"></div></div>
        <div class="muted" style="font-size:12px;margin:6px 0">Map © OpenStreetMap contributors. Tiles load from openstreetmap.org only while this view is open.</div>
        <div id="map-days"></div>
      </div>`;
      document.body.appendChild(sheet);
      const close = () => sheet.remove();
      sheet.querySelector('#map-close').onclick = close;
      const $map = sheet.querySelector('#map'), canvas = sheet.querySelector('#map-canvas'), $pins = sheet.querySelector('#map-pins');
      const W = $map.clientWidth || 340, H = 260;
      canvas.width = W; canvas.height = H;
      const { zoom, center } = G.fitBounds(pts, W, H);
      const c = G.project(center.lat, center.lng, zoom);
      const origin = { x: c.x - W / 2, y: c.y - H / 2 };
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#21252f'; ctx.fillRect(0, 0, W, H);
      const t0x = Math.floor(origin.x / G.TILE), t0y = Math.floor(origin.y / G.TILE);
      for (let tx = t0x; tx * G.TILE < origin.x + W; tx++) for (let ty = t0y; ty * G.TILE < origin.y + H; ty++) {
        const img = new Image(); img.crossOrigin = 'anonymous';
        img.onload = () => ctx.drawImage(img, tx * G.TILE - origin.x, ty * G.TILE - origin.y);
        img.onerror = () => { ctx.strokeStyle = '#2f3648'; ctx.strokeRect(tx * G.TILE - origin.x, ty * G.TILE - origin.y, G.TILE, G.TILE); };
        const n = Math.pow(2, zoom);
        img.src = G.tileUrl(zoom, ((tx % n) + n) % n, Math.min(n - 1, Math.max(0, ty)));
      }
      const clusters = G.cluster(pts, 28, zoom);
      $pins.innerHTML = clusters.map((cl, i) => { const pp = G.project(cl.lat, cl.lng, zoom); return `<button class="pin" data-i="${i}" style="left:${pp.x - origin.x}px;top:${pp.y - origin.y}px">${cl.items.length}</button>`; }).join('');
      $pins.onclick = (e) => { const b = e.target.closest('.pin'); if (!b) return; close(); const first = clusters[Number(b.dataset.i)].items[0]; const idx = visible.findIndex((p) => p.id === first.id); if (idx >= 0) openLightbox(idx); };
      const days = G.clusterByDay(pts);
      sheet.querySelector('#map-days').innerHTML = [...days.entries()].map(([k, list]) => `<div class="cmt"><b>${h(dayLabel(k))}</b> · ${list.length} photo${list.length === 1 ? '' : 's'} · ${G.cluster(list, 40, zoom).length} place${G.cluster(list, 40, zoom).length === 1 ? '' : 's'}</div>`).join('');
    }

    // ------------------------------------------------------------ photos of me (all on this device)
    async function findMe() {
      const F = window.TLFace;
      const sheet = document.createElement('div');
      sheet.className = 'sheet'; sheet.id = 'me-sheet';
      sheet.innerHTML = `<div class="sheet-body">
        <div class="row between"><h2>Find photos of me</h2><button class="btn small" id="me-close">✕</button></div>
        <p>Take or pick a clear selfie. Faces are compared <b>on this phone only</b> – the selfie and the face data never leave it. Uses the browser's face detector where available (${typeof window.FaceDetector === 'function' ? 'available here' : 'not available here – whole photos are compared instead'}).</p>
        <label class="btn primary block" for="selfie">🤳 Take / choose a selfie</label>
        <input type="file" id="selfie" accept="image/*" capture="user" hidden>
        <div class="muted" id="me-progress" style="margin-top:10px"></div>
      </div>`;
      document.body.appendChild(sheet);
      sheet.querySelector('#me-close').onclick = () => sheet.remove();
      sheet.querySelector('#selfie').onchange = async (e) => {
        const f = e.target.files[0]; if (!f) return;
        const $p = sheet.querySelector('#me-progress');
        try {
          const bmp = await createImageBitmap(f);
          const selfieFaces = await F.embedFaces(bmp, bmp.width, bmp.height);
          if (!selfieFaces.length) throw new Error('No face found in the selfie');
          const selfie = selfieFaces[0].embedding;
          const candidates = photos.filter((p) => p.kind !== 'video' && p.thumbUrl && !p.reportedByMe);
          const matches = new Set();
          let done = 0;
          for (const p of candidates) {
            try {
              const b = await createImageBitmap(await (await fetch(p.thumbUrl)).blob());
              const faces = await F.embedFaces(b, b.width, b.height);
              if (F.bestMatch(faces, selfie) >= F.DEFAULT_THRESHOLD) matches.add(p.id);
              b.close && b.close();
            } catch { /* skip unreadable */ }
            done++; $p.textContent = `Checked ${done} of ${candidates.length}…`;
          }
          meMatches = matches;
          filter = { type: 'me' };
          sheet.remove(); applyFilter();
          toast(matches.size ? `${matches.size} photo${matches.size === 1 ? '' : 's'} look like you` : 'No matches – try a clearer selfie');
        } catch (err) { $p.textContent = err.message; }
      };
    }

    // ------------------------------------------------------------ export sheet
    function openExport() {
      const sheet = document.createElement('div');
      sheet.className = 'sheet'; sheet.id = 'export-sheet';
      const canPickDir = typeof window.showDirectoryPicker === 'function';
      const ios = isIOS();
      sheet.innerHTML = `<div class="sheet-body">
        <div class="row between"><h2>Get the photos</h2><button class="btn small" id="x-close">✕</button></div>
        <button class="btn block primary" id="x-zip">⬇ Download all as one .zip (${photos.length})</button>
        <button class="btn block" id="x-fav">♥ Download my favourites (${photos.filter((p) => p.favourited).length})</button>
        ${canPickDir ? '<button class="btn block" id="x-folder">📁 Save every file into a folder on this device</button>' : ''}
        <div class="card" style="margin-top:14px">
          <h2 style="font-size:16px">Into your photo library</h2>
          ${ios ? '<p><b>iPhone / iPad:</b> download the zip, open the <b>Files</b> app → Downloads → tap the zip to unpack → open the folder → Select → Select All → Share → <b>Save to Photos</b>. They will appear in Photos and iCloud.</p>'
            : '<p><b>Android:</b> download the zip, open <b>Files</b> → Downloads → tap the zip → Extract. The extracted folder is picked up by Google Photos backup automatically (turn on backup for that folder in Google Photos → Library → Folders).</p>'}
          <p><b>Computer:</b> download the zip and drag the folder into Google Photos, iCloud Photos or Lightroom.</p>
        </div>
      </div>`;
      document.body.appendChild(sheet);
      const close = () => sheet.remove();
      sheet.querySelector('#x-close').onclick = close;
      sheet.addEventListener('click', (e) => { if (e.target === sheet) close(); });
      sheet.querySelector('#x-zip').onclick = async () => { try { await zipDownload(code, rec); close(); } catch (err) { toast(err.message, true); } };
      sheet.querySelector('#x-fav').onclick = async () => { try { await zipDownload(code, rec, { favourites: true }); close(); } catch (err) { toast(err.message, true); } };
      const $folder = sheet.querySelector('#x-folder');
      if ($folder) $folder.onclick = async () => {
        try {
          const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
          let n = 0;
          for (const p of photos) {
            const res = await fetch(`${p.originalUrl || p.url}?download=1`);
            const name = (res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/)?.[1] || `${p.id}.${p.mime.split('/')[1]}`;
            const fh = await dir.getFileHandle(name, { create: true });
            const w = await fh.createWritable(); await res.body.pipeTo(w); n++;
            $folder.textContent = `Saving… ${n}/${photos.length}`;
          }
          toast(`${n} files saved`); close();
        } catch (err) { if (err.name !== 'AbortError') toast(err.message, true); }
      };
    }

    load();
    const unsub = onSync((ev) => { if (ev.type === 'done' || ev.type === 'failed') load(); });
    const timer = setInterval(() => { if (!document.hidden && !$lb) load(); }, 15000);

    // iOS Safari: the one-time "add to home screen" sheet, shown the first time the gallery opens.
    if (isIOS() && !TL.isStandalone() && !localStorage.getItem('triplink:ios-hint')) {
      const sheet = document.createElement('div');
      sheet.className = 'sheet'; sheet.id = 'ios-install';
      sheet.innerHTML = `<div class="sheet-body">
          <h2>Put TripLink on your home screen</h2>
          <p>Then it opens full-screen with its own icon, straight to the camera.</p>
          <ol class="steps">
            <li><span class="step-ic"><svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg></span><span>Tap the <b>Share</b> button at the bottom of Safari</span></li>
            <li><span class="step-ic"><svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M12 8v8M8 12h8"/></svg></span><span>Choose <b>Add to Home Screen</b>, then <b>Add</b></span></li>
          </ol>
          <button class="btn primary block" id="ios-ok">Got it</button>
        </div>`;
      document.body.appendChild(sheet);
      sheet.querySelector('#ios-ok').onclick = () => { localStorage.setItem('triplink:ios-hint', '1'); sheet.remove(); };
    }

    return () => { clearInterval(timer); unsub(); closeLightbox(); window.removeEventListener('scroll', onScroll); window.removeEventListener('resize', onResize); document.querySelector('#export-sheet')?.remove(); };
  }

  return { tabPhotos, zipDownload };
};
