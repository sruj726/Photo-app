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

function loadPlaywright() {
  try { return require('playwright'); } catch { /* not installed locally */ }
  const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
  return require(path.join(globalRoot, 'playwright'));
}
const { chromium } = loadPlaywright();

const ROOT = path.resolve(__dirname, '..');
const SHOTS = process.env.SHOTS || null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const shot = (page, name) => (SHOTS ? page.screenshot({ path: path.join(SHOTS, `${name}.png`) }) : Promise.resolve());

async function startServer() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triplink-smoke-'));
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, env: { ...process.env, PORT: '0', DATA_DIR: dataDir, LOG: 'off' }, stdio: ['ignore', 'pipe', 'pipe'],
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
  // Full headless Chromium (not the headless shell): the shell cannot grant notification permission.
  const launchArgs = { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] };
  let browser;
  try { browser = await chromium.launch({ channel: 'chromium', ...launchArgs }); }
  catch { browser = await chromium.launch(launchArgs); }
  const errors = [];
  const newContext = async () => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, permissions: ['camera', 'notifications'], acceptDownloads: true });
    await ctx.grantPermissions(['camera', 'notifications'], { origin: base });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    // Chromium reports every non-2xx fetch as a console error. 401/404/409/410 are answers the app
    // handles on purpose (expired link, removed member, duplicate photo), so only other errors count.
    const EXPECTED_HTTP = /Failed to load resource: the server responded with a status of (401|404|409|410)\b/;
    page.on('console', (m) => { if (m.type() === 'error' && !EXPECTED_HTTP.test(m.text())) errors.push(`console: ${m.text()}`); });
    page.on('dialog', (d) => d.accept());
    return page;
  };
  const log = (...a) => console.log('  ✓', ...a);

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
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('All photos are in the trip'), null, { timeout: 20000 });
    await page.setInputFiles('#file', path.join(ROOT, 'public', 'icon-512.png'));
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('All photos are in the trip'), null, { timeout: 20000 });
    log('two shutter photos + one import uploaded');

    // ---- duplicate import is accepted silently (server answers 409, client treats as done)
    await page.setInputFiles('#file', path.join(ROOT, 'public', 'icon-512.png'));
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('All photos are in the trip'), null, { timeout: 20000 });
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
    await page.waitForFunction(() => document.querySelectorAll('#grid button[data-i]').length === 3, null, { timeout: 15000 });
    assert.match(await page.$eval('#retention', (e) => e.textContent), /kept until/i);
    await shot(page, '03-photos');
    await page.click('#grid button[data-i="0"]');
    await page.waitForSelector('.lightbox img');
    await shot(page, '04-lightbox');
    await page.click('.lightbox #close');
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
    await p2.waitForFunction(() => document.querySelectorAll('#grid button[data-i]').length === 3, null, { timeout: 15000 });
    await p2.click('#grid button[data-i="0"]');
    await p2.waitForSelector('.lightbox');
    assert.equal(await p2.$('.lightbox #del'), null, 'guest cannot delete others photos');
    await p2.click('.lightbox #close');
    // Reciprocity nudge: Priya has 0, Srujan has 3.
    await p2.waitForSelector('#reciprocity:not([hidden])');
    assert.match(await p2.$eval('#reciprocity', (e) => e.textContent), /You added 0 · Srujan 3/);
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
    await pi.waitForSelector('#grid button[data-i]');
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
    await page.click('#save-settings');
    await page.waitForFunction(() => document.querySelector('.trip-header h1')?.textContent === 'Goa 2026', null, { timeout: 10000 });
    log('trip renamed with dates');

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
    process.exitCode = 1;
  } finally {
    await browser.close();
    srv.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})();
