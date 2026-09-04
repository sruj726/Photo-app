'use strict';
/* Phase 6: app-link well-known files, share target manifest, native project scaffolding. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'triplink-p6-'));
process.env.PORT = '0';
process.env.LOG = 'off';
process.env.ANDROID_PACKAGE = 'app.triplink.twa';
process.env.ANDROID_SHA256_FINGERPRINTS = 'AA:BB:CC, DD:EE:FF';
process.env.IOS_APP_ID = 'TEAM123456.app.triplink.ios';
const { server, DATA_DIR } = require('../server.js');

let base;
before(async () => { await new Promise((r) => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`; });
after(async () => { await new Promise((r) => server.close(r)); fs.rmSync(DATA_DIR, { recursive: true, force: true }); });

test('assetlinks.json is generated from env', async () => {
  const r = await fetch(`${base}/.well-known/assetlinks.json`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /application\/json/);
  const body = await r.json();
  assert.equal(body[0].relation[0], 'delegate_permission/common.handle_all_urls');
  assert.equal(body[0].target.package_name, 'app.triplink.twa');
  assert.deepEqual(body[0].target.sha256_cert_fingerprints, ['AA:BB:CC', 'DD:EE:FF']);
});

test('apple-app-site-association covers /t/* and is JSON', async () => {
  const r = await fetch(`${base}/.well-known/apple-app-site-association`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /application\/json/);
  const body = await r.json();
  assert.deepEqual(body.applinks.details[0].appIDs, ['TEAM123456.app.triplink.ios']);
  assert.equal(body.applinks.details[0].components[0]['/'], '/t/*');
  assert.deepEqual(body.webcredentials.apps, ['TEAM123456.app.triplink.ios']);
});

test('manifest declares a share target that accepts images and videos', () => {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'manifest.webmanifest'), 'utf8'));
  assert.equal(m.share_target.action, '/share-target');
  assert.equal(m.share_target.method, 'POST');
  assert.equal(m.share_target.enctype, 'multipart/form-data');
  assert.equal(m.share_target.params.files[0].name, 'media');
  assert.deepEqual(m.share_target.params.files[0].accept, ['image/*', 'video/*']);
});

test('native projects: manifest host/package and plugin registration are consistent', () => {
  const root = path.join(__dirname, '..', 'native');
  const manifest = fs.readFileSync(path.join(root, 'android/app/src/main/AndroidManifest.xml'), 'utf8');
  const strings = fs.readFileSync(path.join(root, 'android/app/src/main/res/values/strings.xml'), 'utf8');
  const gradle = fs.readFileSync(path.join(root, 'android/app/build.gradle'), 'utf8');
  assert.match(manifest, /package="app\.triplink\.twa"/);
  assert.match(gradle, /applicationId "app\.triplink\.twa"/);
  const host = manifest.match(/android:host="([^"]+)"/)[1];
  assert.ok(strings.includes(`https://${host}`), 'asset statement site matches the App Links host');
  assert.match(manifest, /android:pathPrefix="\/t\/"/);
  const swift = fs.readFileSync(path.join(root, 'ios/ios-plugin/TripLinkNative.swift'), 'utf8');
  const objc = fs.readFileSync(path.join(root, 'ios/ios-plugin/TripLinkNative.m'), 'utf8');
  for (const method of ['enqueueUpload', 'pending']) {
    assert.match(swift, new RegExp(`@objc func ${method}\\(`));
    assert.match(objc, new RegExp(`CAP_PLUGIN_METHOD\\(${method},`));
  }
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'ios/capacitor.config.json'), 'utf8'));
  assert.equal(cfg.appId, 'app.triplink.ios');
  assert.match(cfg.server.url, /^https:\/\//);
  const bridge = fs.readFileSync(path.join(root, 'ios/ios-plugin/bridge.js'), 'utf8');
  assert.match(bridge, /triplink:native-upload-done/);
  assert.match(bridge, /triplink:native-upload-failed/);
});
