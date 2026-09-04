'use strict';
/* QR encoder: matrices must match reference codes produced by an independent encoder
 * (python-qrcode, EC level M, byte mode, forced mask) module for module. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const QR = require('../public/qr.js');
const fixtures = require('./fixtures/qr-reference.json');

for (const f of fixtures) {
  test(`matches reference: v${f.version} mask ${f.mask} "${f.text.slice(0, 24)}"`, () => {
    const m = QR.encode(f.text, { version: f.version, mask: f.mask });
    assert.equal(m.size, f.version * 4 + 17);
    const rows = m.rows();
    const diffs = [];
    for (let y = 0; y < m.size; y++) for (let x = 0; x < m.size; x++) if (rows[y][x] !== f.rows[y][x]) diffs.push([x, y]);
    assert.deepEqual(diffs, [], `${diffs.length} modules differ`);
  });
}

test('auto version + mask produce a valid symbol', () => {
  const m = QR.encode('https://photos.example.com/t/abcdefghjk');
  assert.equal(m.version, 3);
  assert.ok(m.mask >= 0 && m.mask <= 7);
  // Finder pattern corner is dark, separator light, dark module present.
  assert.equal(m.get(0, 0), true);
  assert.equal(m.get(7, 7), false);
  assert.equal(m.get(8, m.size - 8), true);
  // Masking is deterministic: forcing the auto-chosen mask reproduces the same matrix.
  const forced = QR.encode('https://photos.example.com/t/abcdefghjk', { mask: m.mask });
  assert.deepEqual(forced.rows(), m.rows());
});

test('capacity limits and errors', () => {
  assert.equal(QR.capacityBytes(1), 14);
  assert.equal(QR.capacityBytes(10), 213);
  assert.throws(() => QR.encode('x'.repeat(214)), /too long/);
  assert.equal(QR.encode('x'.repeat(213)).version, 10);
});

test('toSvg renders one path per dark module with a quiet zone', () => {
  const m = QR.encode('hi');
  const svg = QR.toSvg(m, { scale: 2, quiet: 4 });
  assert.match(svg, /^<svg /);
  const dim = (m.size + 8) * 2;
  assert.ok(svg.includes(`viewBox="0 0 ${dim} ${dim}"`));
  const dark = m.rows().flat().filter(Boolean).length;
  assert.equal((svg.match(/M\d+ \d+h2v2h-2z/g) || []).length, dark);
});
