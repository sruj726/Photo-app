'use strict';
/* Phase 7 pure modules: sharpness + bursts, geo projection/clustering, face embedding/matching. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Q = require('../public/ml/quality.js');
const G = require('../public/ml/geo.js');
const F = require('../public/ml/face.js');

function image(w, h, fn) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = fn(x, y); const i = (y * w + x) * 4; data[i] = data[i + 1] = data[i + 2] = v; data[i + 3] = 255; }
  return { data, width: w, height: h };
}

test('sharpness: checkerboard >> smooth gradient >> flat', () => {
  const flat = Q.sharpnessOfImageData(image(32, 32, () => 128));
  const gradient = Q.sharpnessOfImageData(image(32, 32, (x) => x * 8));
  const checker = Q.sharpnessOfImageData(image(32, 32, (x, y) => ((x + y) % 2 ? 255 : 0)));
  assert.equal(flat, 0);
  assert.ok(gradient < 1, `gradient is smooth (${gradient})`);
  assert.ok(checker > 10000, `checkerboard is very sharp (${checker})`);
  assert.equal(Q.sharpness(new Float32Array(4), 2, 2), 0, 'tiny images score 0');
});

test('groupBursts: same member within 3 s collapses, sharpest wins, videos stand alone', () => {
  const t = 1_700_000_000_000;
  const photos = [
    { id: 'a', memberId: 'm1', takenAt: t + 8000, sharpness: 10 },   // 4 s before b: its own group
    { id: 'b', memberId: 'm1', takenAt: t + 4000, sharpness: 50 },   // burst with c
    { id: 'c', memberId: 'm1', takenAt: t + 2000, sharpness: 20 },
    { id: 'v', memberId: 'm1', takenAt: t + 1500, kind: 'video' },
    { id: 'd', memberId: 'm2', takenAt: t + 1000, sharpness: 5 },    // different member
    { id: 'e', memberId: 'm1', takenAt: t + 500, sharpness: 1 },
  ];
  const groups = Q.groupBursts(photos, 3000);
  assert.deepEqual(groups.map((g) => g.items.map((p) => p.id)), [['a'], ['b', 'c'], ['v'], ['d'], ['e']]);
  assert.equal(groups[1].best.id, 'b');
  assert.equal(groups[2].best.id, 'v');
});

test('geo: projection round-trips, fitBounds picks a zoom that fits, clustering merges nearby points', () => {
  const p = G.project(15.4989, 73.8278, 12);   // Goa
  const back = G.unproject(p.x, p.y, 12);
  assert.ok(Math.abs(back.lat - 15.4989) < 1e-6 && Math.abs(back.lng - 73.8278) < 1e-6);
  assert.deepEqual(G.project(0, 0, 0), { x: 128, y: 128 });
  const pts = [{ lat: 15.50, lng: 73.82 }, { lat: 15.55, lng: 73.90 }, { lat: 15.30, lng: 73.95 }];
  const fit = G.fitBounds(pts, 360, 400);
  assert.ok(fit.zoom >= 9 && fit.zoom <= 12, `zoom ${fit.zoom}`);
  const big = G.project(15.55, 73.90, fit.zoom), small = G.project(15.30, 73.95, fit.zoom);
  assert.ok(Math.abs(big.y - small.y) <= 400 - 80);
  const clusters = G.cluster([{ lat: 15.5000, lng: 73.8200 }, { lat: 15.5001, lng: 73.8201 }, { lat: 15.30, lng: 73.95 }], 30, fit.zoom);
  assert.equal(clusters.length, 2);
  assert.equal(clusters[0].items.length, 2);
  const byDay = G.clusterByDay([{ takenAt: Date.UTC(2026, 2, 10, 12) }, { takenAt: Date.UTC(2026, 2, 10, 15) }, { takenAt: Date.UTC(2026, 2, 11, 9) }]);
  assert.equal(byDay.size, 2);
  assert.match(G.tileUrl(3, 4, 2), /^https:\/\/tile\.openstreetmap\.org\/3\/4\/2\.png$/);
});

test('face fallback embedding: same face (brightness-shifted) matches, different pattern does not', () => {
  const faceA = image(96, 96, (x, y) => 100 + 60 * Math.sin(x / 9) * Math.cos(y / 7));
  const faceAbright = image(96, 96, (x, y) => 160 + 60 * Math.sin(x / 9) * Math.cos(y / 7));
  const faceB = image(96, 96, (x, y) => 100 + 60 * Math.cos(x / 4) * Math.sin(y / 11));
  const ea = F.fallbackEmbed(faceA), eab = F.fallbackEmbed(faceAbright), eb = F.fallbackEmbed(faceB);
  assert.ok(F.cosine(ea, eab) > 0.99, 'illumination-invariant');
  assert.ok(F.cosine(ea, eb) < 0.5, `different faces are far apart (${F.cosine(ea, eb).toFixed(3)})`);
  assert.equal(ea.length, F.SIDE * F.SIDE);
  assert.ok(F.bestMatch([{ embedding: eb }, { embedding: eab }], ea) > F.DEFAULT_THRESHOLD);
  assert.ok(F.bestMatch([{ embedding: eb }], ea) < F.DEFAULT_THRESHOLD);
});

test('face detection falls back to the centre square without the Shape Detection API', async () => {
  const boxes = await F.detectFaces(null, 400, 300);
  assert.deepEqual(boxes, [{ x: 50, y: 0, width: 300, height: 300, wholeImage: true }]);
});
