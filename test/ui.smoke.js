#!/usr/bin/env node
'use strict';
/**
 * Browser smoke test: boots the real server on a random port and drives the PWA in headless
 * Chromium with a fake camera device. Exits non-zero on any page error, console error or
 * failed assertion.
 *
 *   npm run smoke               (SHOTS=/some/dir to keep screenshots)
 *
 * Playwright is resolved from local node_modules first, then from the global npm root, so a
 * plain `npm i -g playwright && npx playwright install chromium` is enough on a dev machine.
 */
const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

function playwrightCandidates() {
  const list = [];
  try { list.push(require('playwright')); } catch { /* not installed locally */ }
  try { list.push(require(path.join(execSync('npm root -g', { encoding: 'utf8' }).trim(), 'playwright'))); } catch { /* no global install */ }
  if (!list.length) throw new Error('Playwright not found: npm i -g playwright && npx playwright install chromium');
  return list;
}
/** Launch full headless Chromium (the headless shell cannot grant notification permission), trying each Playwright install. */
async function launchChromium(args) {
  let lastErr;
  for (const pw of playwrightCandidates()) {
    for (const opts of [{ channel: 'chromium', args }, { args }]) {
      try { return await pw.chromium.launch(opts); } catch (err) { lastErr = err; }
    }
  }
  throw lastErr;
}

const ROOT = path.resolve(__dirname, '..');
const SHOTS = process.env.SHOTS || null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const shot = (page, name) => (SHOTS ? page.screenshot({ path: path.join(SHOTS, `${name}.png`) }) : Promise.resolve());

async function startServer() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triplink-smoke-'));
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, env: { ...process.env, PORT: '0', DATA_DIR: dataDir, LOG: 'off', RATE_LIMIT_PER_MIN: '100000' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stderr.on('data', (d) => { const s = d.toString(); if (!s.includes('ExperimentalWarning') && !s.includes('--trace-warnings')) process.stderr.write(`[server] ${s}`); });
  const base = await new Promise((resolve, reject) => {
    let out = '';
    srv.stdout.on('data', (d) => { out += d.toString(); const m = out.match(/http:\/\/[^\s]+:(\d+)/); if (m) resolve(`http://localhost:${m[1]}`); });
    srv.on('exit', (c) => reject(new Error(`server exited early (${c})`)));
    setTimeout(() => reject(new Error('server did not start')), 15000);
  });
  return { srv, dataDir, base };
}

(async () => {
  const { srv, dataDir, base } = await startServer();
  const browser = await launchChromium(['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']);
  const errors = [];
  const newContext = async () => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, permissions: ['camera', 'notifications'], acceptDownloads: true });
    await ctx.grantPermissions(['camera', 'notifications'], { origin: base });
    const page = await ctx.newPage();
    // Force the chunked (resumable) upload path for everything so the smoke exercises it.
    await page.addInitScript(() => { window.TRIPLINK_CHUNK_THRESHOLD = 1000; });
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    // Chromium reports every non-2xx fetch as a console error. 401/404/409/410 are answers the app
    // handles on purpose (expired link, removed member, duplicate photo), so only other errors count.
    const EXPECTED_HTTP = /Failed to load resource: the server responded with a status of (401|404|409|410)\b/;
    page.on('console', (m) => { if (m.type() === 'error' && !EXPECTED_HTTP.test(m.text())) errors.push(`console: ${m.text()}`); });
    page.on('dialog', (d) => d.accept());
    return page;
  };
  const log = (...a) => console.log('  ✓', ...a);
  const headerCount = (pg) => pg.$eval('#hdr-stats', (e) => Number((e.textContent.match(/(\d+) photo/) || [0, 0])[1]));
  // Uploads finish asynchronously; the header count is refreshed on every completed upload.
  const waitForCount = (pg, n) => pg.waitForFunction((want) => Number((document.querySelector('#hdr-stats')?.textContent.match(/(\d+) photo/) || [0, 0])[1]) >= want, n, { timeout: 30000 });
  const waitQueueEmpty = (pg) => pg.waitForFunction(async () => (await window.TripLink.queueSize()) === 0, null, { timeout: 30000 });
  const clickTile = async (pg, i) => { const tiles = await pg.$$('#grid button[data-id]'); assert.ok(tiles[i], `tile ${i} exists`); await tiles[i].click(); };

  try {
    // ---- organiser creates a trip
    const page = await newContext();
    await page.goto(`${base}/`);
    await shot(page, '01-home');
    await page.fill('#tripName', 'Goa with the gang');
    await page.fill('#yourName', 'Srujan');
    await page.click('#create button[type=submit]');
    await page.waitForURL(/\/t\/[a-z0-9]{10}\?tab=share/);
    let code = page.url().match(/\/t\/([a-z0-9]{10})/)[1];
    await page.waitForSelector('#members li:not(.muted)');
    await shot(page, '02-share');
    log('trip created', code);

    // ---- shutter x2 + gallery import
    await page.click('#tabs button[data-tab=camera]');
    await page.waitForFunction(() => { const v = document.querySelector('#video'); return v && v.videoWidth > 0; }, null, { timeout: 15000 });
    await page.click('#shutter');
    await page.click('#shutter');
    await waitForCount(page, 2);
    await page.setInputFiles('#file', path.join(ROOT, 'public', 'icon-512.png'));
    await waitForCount(page, 3);
    log('two shutter photos + one import uploaded');

    // ---- Phase 3: pause toggle holds uploads; record a short video; import a video file
    await page.check('#pause');
    await page.click('#shutter');
    await page.waitForFunction(() => /Paused – 1 saved/.test(document.querySelector('#status').textContent), null, { timeout: 10000 });
    assert.equal(await headerCount(page), 3, 'nothing uploaded while paused');
    await page.uncheck('#pause');
    await waitForCount(page, 4);
    log('pause toggle holds and releases uploads');
    await page.click('#record');
    await page.waitForSelector('#rec-badge:not([hidden])');
    await page.waitForTimeout(1500);
    await page.click('#record');
    await waitForCount(page, 5);
    assert.ok(!/rejected/.test(await page.$eval('#status', (e) => e.textContent)));
    log('recorded a video with MediaRecorder and uploaded it in chunks');

    // ---- duplicate import is accepted silently (server answers 409, client treats as done)
    await page.setInputFiles('#file', path.join(ROOT, 'public', 'icon-512.png'));
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Already in the trip'), null, { timeout: 20000 });
    await waitQueueEmpty(page);
    assert.equal(await headerCount(page), 5, 'duplicate did not add a photo');
    assert.ok(!errors.length, `errors after duplicate import: ${errors.join('; ')}`);

    // ---- Phase 2: push opt-in banner appears after the first upload; QR + share row on Share tab
    await page.waitForSelector('#push-banner', { timeout: 10000 });
    await page.click('#push-no');
    assert.equal(await page.$('#push-banner'), null);
    await page.click('#tabs button[data-tab=share]');
    await page.waitForSelector('#qr svg');
    assert.ok((await page.$eval('#qr svg', (e) => e.getAttribute('viewBox'))).startsWith('0 0 '));
    assert.match(await page.$eval('#share-wa', (e) => e.href), /^https:\/\/wa\.me\/\?text=/);
    assert.match(await page.$eval('#share-tg', (e) => e.href), /^https:\/\/t\.me\/share\/url/);
    assert.equal(await page.$eval('#code-big', (e) => e.textContent), code);
    await page.click('#print-card');
    await page.waitForSelector('#join-card .jc-qr svg');
    assert.equal(await page.$eval('.jc-code', (e) => e.textContent), code);
    await shot(page, '02b-join-card');
    await page.goBack();
    await page.waitForSelector('#tabs');
    log('push banner, QR, share buttons and join card');

    // ---- gallery + lightbox + zip
    await page.click('#tabs button[data-tab=photos]');
    await page.waitForFunction(() => document.querySelectorAll('#grid button[data-id]').length === 5, null, { timeout: 15000 });
    assert.match(await page.$eval('#retention', (e) => e.textContent), /kept until/i);
    assert.equal(await page.$$eval('#grid .play', (els) => els.length), 1, 'one video tile with a play badge');
    assert.ok(await page.$('.day-head'), 'day section header rendered');
    assert.match(await page.$eval('#chips', (e) => e.textContent), /All 5.*Videos 1.*Srujan 5/s);
    await shot(page, '03-photos');
    // Newest first: the video is tile 0 and opens in a <video> element.
    await clickTile(page, 0);
    await page.waitForSelector('.lightbox video');
    await page.click('.lightbox #close');
    await clickTile(page, 1);
    await page.waitForSelector('.lightbox img');
    await shot(page, '04-lightbox');
    // Phase 4: heart, comment, keyboard navigation
    await page.click('.lightbox #heart');
    await page.waitForFunction(() => document.querySelector('.lightbox #heart-n')?.textContent === '1');
    await page.click('.lightbox #comments');
    await page.waitForSelector('#cpanel:not([hidden])');
    await page.fill('#ctext', 'Lovely light here');
    await page.press('#ctext', 'Enter');
    await page.waitForSelector('.cmt');
    assert.match(await page.$eval('.cmt', (e) => e.textContent), /Srujan.*Lovely light here/);
    assert.equal(await page.$eval('.lightbox #cmt-n', (e) => e.textContent), '1');
    const srcBefore = await page.$eval('.lightbox .stage img', (e) => e.src);
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction((prev) => { const im = document.querySelector('.lightbox .stage img, .lightbox .stage video'); return im && im.src !== prev; }, srcBefore);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.lightbox', { state: 'detached' });
    await page.waitForFunction(() => document.querySelectorAll('#grid .hearts').length === 1 && document.querySelectorAll('#grid .cmts').length === 1);
    await page.click('#export');
    await page.waitForSelector('#export-sheet');
    assert.match(await page.$eval('#x-fav', (e) => e.textContent), /\(1\)/);
    await page.click('#x-close');
    await page.click('#chips .chip:nth-child(3)');   // 🎥 Videos
    await page.waitForFunction(() => document.querySelectorAll('#grid button[data-id]').length === 1);
    await page.click('#chips .chip:nth-child(1)');   // All
    await page.waitForFunction(() => document.querySelectorAll('#grid button[data-id]').length === 5);
    log('day sections, filter chips, heart, comment, keyboard nav and export sheet');
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), page.click('#zip')]);
    const zipSize = fs.statSync(await dl.path()).size;
    assert.ok(zipSize > 1000, 'zip has content');
    log('gallery, lightbox and zip download', dl.suggestedFilename(), `${zipSize} bytes`);

    // ---- second traveler joins by link
    const p2 = await newContext();
    await p2.goto(`${base}/t/${code}`);
    await p2.waitForSelector('#join');
    await shot(p2, '05-join');
    await p2.fill('#name', 'Priya');
    await p2.click('#join button');
    await p2.waitForSelector('#shutter');
    await p2.click('#tabs button[data-tab=photos]');
    await p2.waitForFunction(() => document.querySelectorAll('#grid button[data-id]').length === 5, null, { timeout: 15000 });
    await clickTile(p2, 1);
    await p2.waitForSelector('.lightbox');
    assert.equal(await p2.$('.lightbox #del'), null, 'guest cannot delete others photos');
    await p2.click('.lightbox #close');
    // Reciprocity nudge: Priya has 0, Srujan has 5.
    await p2.waitForSelector('#reciprocity:not([hidden])');
    assert.match(await p2.$eval('#reciprocity', (e) => e.textContent), /You added 0 · Srujan 5/);
    log('second traveler joined, sees the album and the reciprocity nudge');

    // ---- iOS Safari: one-time install sheet on the gallery
    const ios = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, permissions: ['camera'],
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });
    const pi = await ios.newPage();
    pi.on('pageerror', (e) => errors.push(`pageerror(ios): ${e.message}`));
    await pi.goto(`${base}/t/${code}`);
    await pi.fill('#name', 'Kiran'); await pi.click('#join button');
    await pi.waitForSelector('#shutter');
    await pi.click('#tabs button[data-tab=photos]');
    await pi.waitForSelector('#ios-install');
    await shot(pi, '05b-ios-sheet');
    await pi.click('#ios-ok');
    await pi.reload();
    await pi.waitForSelector('#tabs');
    await pi.click('#tabs button[data-tab=photos]');
    await pi.waitForSelector('#grid button[data-id]');
    assert.equal(await pi.$('#ios-install'), null, 'sheet shown only once');
    await ios.close();
    log('iOS install sheet shown once');

    // ---- guest renames themselves
    await p2.click('#tabs button[data-tab=share]');
    await p2.waitForSelector('#members li:not(.muted)');
    await p2.evaluate(() => { window.prompt = () => 'Priya S'; });
    await p2.click('#rename-me');
    await p2.waitForFunction(() => document.querySelector('#members').textContent.includes('Priya S'), null, { timeout: 10000 });
    log('member renamed themselves');

    // ---- owner: trip settings (rename + dates), rotate link, remove member
    await page.click('#tabs button[data-tab=share]');
    await page.waitForSelector('#trip-settings');
    await page.fill('#set-name', 'Goa 2026');
    await page.fill('#set-start', '2026-03-10');
    await page.fill('#set-end', '2026-03-14');
    await page.check('#set-originals');
    await page.click('#save-settings');
    await page.waitForFunction(() => document.querySelector('.trip-header h1')?.textContent === 'Goa 2026', null, { timeout: 10000 });
    log('trip renamed with dates, originals switched on');

    // With originals on, an imported file is stored untouched next to the resized copy.
    await page.click('#tabs button[data-tab=camera]');
    await page.setInputFiles('#file', path.join(ROOT, 'public', 'icon-192.png'));
    await waitForCount(page, 6);
    await waitQueueEmpty(page);
    await page.click('#tabs button[data-tab=photos]');
    await page.waitForFunction(() => document.querySelectorAll('#grid button[data-id]').length === 6, null, { timeout: 15000 });
    // Imported files sort by their file-modified time, so find the tile that carries an original.
    let foundOriginal = false;
    for (let i = 0; i < 6 && !foundOriginal; i++) {
      await clickTile(page, i);
      await page.waitForSelector('.lightbox');
      const link = await page.$('.lightbox #save-original');
      if (link) { assert.match(await link.evaluate((e) => e.href), /\/original\?download=1$/); foundOriginal = true; }
      await page.click('.lightbox #close');
    }
    assert.ok(foundOriginal, 'one item offers its original');
    log('original kept for imports when the trip keeps originals');
    await page.click('#tabs button[data-tab=share]');
    await page.waitForSelector('#trip-settings');

    await page.waitForSelector('#members li:not(.muted)');
    await page.click('#extend');
    await page.waitForFunction(() => /kept until/i.test(document.querySelector('#expiry')?.textContent || ''), null, { timeout: 10000 });

    await page.click('#rotate');
    await page.waitForURL((u) => !u.toString().includes(code), { timeout: 10000 });
    const newCode = page.url().match(/\/t\/([a-z0-9]{10})/)[1];
    assert.notEqual(newCode, code);
    await page.waitForSelector('#trip-settings');
    log('link rotated', code, '->', newCode);

    // old link shows the expired screen for a stranger
    const p3 = await newContext();
    await p3.goto(`${base}/t/${code}`);
    await p3.waitForSelector('#expired');
    await shot(p3, '06-expired');
    log('old link shows expired screen');

    // Priya only knows the old link, but she is already a member: she is forwarded to the new code.
    await p2.goto(`${base}/t/${code}`);
    await p2.waitForSelector('#shutter');
    assert.ok(p2.url().includes(newCode), 'existing member forwarded to the rotated code');
    log('existing member forwarded from old link to new code');

    // owner removes Priya
    await page.waitForSelector('button.remove-member');
    await page.click('button.remove-member');
    await page.waitForFunction(() => !document.querySelector('#members').textContent.includes('Priya'), null, { timeout: 10000 });
    await p2.reload();
    await p2.waitForSelector('#join');
    log('member removed; their device falls back to the join screen');

    // ---- Phase 5: approval + PIN + brand colour via settings; a newcomer waits for approval
    await page.waitForSelector('#trip-settings');
    await page.selectOption('#set-join', 'approval');
    await page.fill('#set-pin', '2468');
    await page.fill('#set-brand', '#1e90ff');
    await page.click('#save-settings');
    await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() === '#1e90ff', null, { timeout: 10000 });
    await page.waitForSelector('#trip-settings');
    assert.equal(await page.$eval('#set-join', (e) => e.value), 'approval');
    log('approval mode, PIN and brand colour saved; accent colour applied');

    const pk = await newContext();
    await pk.goto(`${base}/t/${newCode}`);
    await pk.waitForSelector('#pin');
    await pk.fill('#name', 'Meera');
    await pk.fill('#pin', '0000');
    await pk.click('#join button');
    await pk.waitForFunction(() => /Wrong PIN/.test(document.querySelector('#toast')?.textContent || ''), null, { timeout: 10000 });
    await pk.fill('#pin', '2468');
    await pk.click('#join button');
    await pk.waitForSelector('#pending');
    await shot(pk, '09-pending');
    log('wrong PIN rejected, right PIN leads to the waiting-for-approval screen');

    await page.waitForSelector('#pending-card:not([hidden]) .approve', { timeout: 20000 });
    await page.click('#pending-card .approve');
    await pk.waitForSelector('#shutter', { timeout: 15000 });
    log('organiser approved from the Share tab; the newcomer was let in automatically');

    // ---- reports: hidden for the reporter, reviewed by the organiser
    await pk.click('#tabs button[data-tab=photos]');
    await pk.waitForFunction(() => document.querySelectorAll('#grid button[data-id]').length === 6, null, { timeout: 15000 });
    await clickTile(pk, 0);
    await pk.waitForSelector('.lightbox #report');
    await pk.click('.lightbox #report');
    await pk.waitForFunction(() => document.querySelectorAll('#grid button[data-id]').length === 5, null, { timeout: 10000 });
    await page.click('#tabs button[data-tab=photos]');
    await page.waitForSelector('#chips .chip');
    await page.click('#refresh');
    await page.waitForFunction(() => /Reported 1/.test(document.querySelector('#chips')?.textContent || ''), null, { timeout: 20000 });
    await page.click('#chips .chip:has-text("Reported")');
    await page.waitForFunction(() => document.querySelectorAll('#grid button[data-id]').length === 1);
    await clickTile(page, 0);
    await page.waitForSelector('.lightbox #dismiss-reports');
    await page.click('.lightbox #dismiss-reports');
    await page.waitForFunction(() => !/Reported/.test(document.querySelector('#chips')?.textContent || ''), null, { timeout: 15000 });
    log('report hides the photo for the reporter; organiser reviewed and kept it');

    // ---- co-organiser: owner promotes Kiran, who then sees the settings but not the delete button
    await page.click('#tabs button[data-tab=share]');
    await page.waitForSelector('#members li:has-text("Meera") button.role-toggle');
    await page.click('#members li:has-text("Meera") button.role-toggle');
    await page.waitForFunction(() => /Meera[^]*organiser/.test(document.querySelector('#members li:has(.pill.warn)')?.textContent || ''), null, { timeout: 10000 });
    await pk.goto(`${base}/t/${newCode}?tab=share`);
    await pk.waitForSelector('#trip-settings');
    assert.equal(await pk.$('#delete-trip'), null, 'organisers cannot delete the trip');
    await pk.context().close();
    log('co-organiser (Meera) promoted and sees organiser tools');

    // ---- school preset
    await page.click('#preset-school');
    await page.click('#save-settings');
    await page.waitForFunction(() => /School mode is on/.test(document.querySelector('#preset-school')?.textContent || ''), null, { timeout: 10000 });
    assert.equal(await page.$eval('#set-comments', (e) => e.checked), false);
    log('school preset applied');

    // ---- virtualised grid: a 240-photo trip renders only what is near the viewport
    {
      const r = await fetch(`${base}/api/trips`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Big trip', creatorName: 'Owner' }) }).then((x) => x.json());
      const jpeg = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'tiny.jpg'));
      const N = 240;
      for (let start = 0; start < N; start += 24) {
        const statuses = await Promise.all(Array.from({ length: Math.min(24, N - start) }, (_, k) => { const i = start + k; return fetch(`${base}/api/trips/${r.trip.code}/photos`, {
          method: 'POST', headers: { 'X-Member-Token': r.member.token, 'Content-Type': 'application/octet-stream', 'X-Photo-Meta': JSON.stringify({ takenAt: Date.now() - i * 3600 * 1000 * 5 }) },
          body: Buffer.concat([jpeg, Buffer.from(String(i).padStart(4, '0'))]),
        }).then((x) => x.status); }));
        assert.ok(statuses.every((st) => st === 201), `bulk upload statuses: ${statuses.join(',')}`);
      }
      const pv = await newContext();
      await pv.goto(`${base}/`);
      await pv.evaluate(({ code, rec }) => localStorage.setItem('triplink:trips', JSON.stringify({ [code]: rec })), { code: r.trip.code, rec: { token: r.member.token, memberId: r.member.id, name: 'Owner', tripName: 'Big trip', isOwner: true, joinedAt: Date.now() } });
      await pv.goto(`${base}/t/${r.trip.code}?tab=photos`);
      await pv.waitForFunction(() => document.querySelectorAll('#grid .vtile').length > 0);
      const rendered = await pv.$$eval('#grid .vtile', (els) => els.length);
      const total = await pv.$eval('#count', (e) => Number(e.textContent.match(/(\d+) photo/)[1]));
      assert.equal(total, N);
      assert.ok(rendered < N / 2, `only a window is rendered (${rendered} of ${N})`);
      assert.ok((await pv.$$eval('.day-head', (els) => els.length)) >= 1);
      await pv.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await pv.waitForFunction(() => { const t = document.querySelectorAll('#grid .vtile'); return t.length && t[t.length - 1].getBoundingClientRect().top < window.innerHeight; });
      const lastRendered = await pv.$$eval('#grid .vtile', (els) => els.length);
      assert.ok(lastRendered < N / 2, 'still windowed after scrolling to the end');
      await shot(pv, '08-virtualised');
      log(`virtualised grid: ${rendered} tiles rendered for ${N} photos, scroll to end works`);
    }

    // ---- Web Share Target: a file POSTed to /share-target is intercepted by the service worker,
    //      queued for the last opened trip and uploaded by the app.
    {
      const before = await headerCount(page);
      const landed = await page.evaluate(async () => {
        const c = document.createElement('canvas'); c.width = 64; c.height = 64;
        const ctx = c.getContext('2d'); ctx.fillStyle = '#7b2cbf'; ctx.fillRect(0, 0, 64, 64); ctx.fillStyle = '#fff'; ctx.fillText(String(Date.now()), 2, 30);
        const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
        const fd = new FormData(); fd.append('media', new File([blob], 'shared.png', { type: 'image/png' })); fd.append('title', 'from the gallery app');
        const res = await fetch('/share-target', { method: 'POST', body: fd });
        return res.url;
      });
      assert.match(landed, /\/t\/[a-z0-9]+\?shared=1$/, `share target redirected to the trip (${landed})`);
      await page.evaluate(() => window.TripLink.sync());
      await waitForCount(page, before + 1);
      log('share target queued a shared file for the last trip and it was uploaded');
    }

    // ---- owner deletes the trip (two-step)
    await page.click('#delete-trip');
    await page.waitForSelector('#delete-trip-confirm');
    await page.click('#delete-trip-confirm');
    await page.waitForURL(`${base}/`);
    await page.waitForSelector('#create');
    const p4 = await newContext();
    await p4.goto(`${base}/t/${newCode}`);
    await p4.waitForFunction(() => document.body.textContent.includes('Trip not found'), null, { timeout: 10000 });
    log('trip deleted; link now says trip not found');

    const swState = await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.active?.state);
    assert.equal(swState, 'activated', 'service worker active');

    if (errors.length) throw new Error(`Browser errors:\n${errors.join('\n')}`);
    console.log('SMOKE OK');
  } catch (err) {
    console.error('SMOKE FAILED:', err && err.stack || err);
    // Dump state from every open page to make failures diagnosable from CI logs.
    for (const ctx of browser.contexts()) for (const pg of ctx.pages()) {
      try {
        const state = await pg.evaluate(() => ({ url: location.href, status: document.querySelector('#status')?.textContent, tiles: document.querySelectorAll('#grid button').length, count: document.querySelector('#count')?.textContent, chips: document.querySelector('#chips')?.textContent, toast: document.querySelector('#toast')?.textContent, trips: localStorage.getItem('triplink:trips') }));
        console.error('  page state:', JSON.stringify(state));
        if (SHOTS) await pg.screenshot({ path: path.join(SHOTS, 'FAILED.png') });
      } catch { /* page gone */ }
    }
    process.exitCode = 1;
  } finally {
    await browser.close();
    srv.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})();
