/* Minimal QR code encoder (byte mode, error-correction level M, versions 1–10).
 * No dependencies, no network. Works in the browser (window.QR) and in Node (module.exports).
 *
 *   const m = QR.encode('https://example.com/t/abc');   // m.size, m.get(x, y) -> boolean (dark)
 *   QR.toSvg(m, { scale: 6 })                            // SVG string
 *   QR.encode(text, { mask: 3 })                         // force a mask (used by the tests)
 *
 * Implementation follows ISO/IEC 18004; structure mirrors the well-known reference encoders.
 */
(function (root) {
  'use strict';

  // ---- Galois field GF(256), primitive polynomial 0x11d
  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  (function () {
    let x = 1;
    for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();
  const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

  function rsGenerator(degree) {
    let poly = [1];
    for (let i = 0; i < degree; i++) {
      const next = new Array(poly.length + 1).fill(0);
      for (let j = 0; j < poly.length; j++) { next[j] ^= poly[j]; next[j + 1] ^= gfMul(poly[j], EXP[i]); }
      poly = next;
    }
    return poly;
  }
  function rsRemainder(data, gen) {
    const res = new Array(gen.length - 1).fill(0);
    for (const b of data) {
      const factor = b ^ res.shift();
      res.push(0);
      for (let i = 0; i < res.length; i++) res[i] ^= gfMul(gen[i + 1], factor);
    }
    return res;
  }

  // ---- Version tables for EC level M: [ecCodewordsPerBlock, [[blocks, dataCodewords], ...]]
  const EC_M = {
    1: [10, [[1, 16]]], 2: [16, [[1, 28]]], 3: [26, [[1, 44]]], 4: [18, [[2, 32]]], 5: [24, [[2, 43]]],
    6: [16, [[4, 27]]], 7: [18, [[4, 31]]], 8: [22, [[2, 38], [2, 39]]], 9: [22, [[3, 36], [2, 37]]], 10: [26, [[4, 43], [1, 44]]],
  };
  const MAX_VERSION = 10;
  const dataCodewords = (v) => EC_M[v][1].reduce((n, [blocks, cw]) => n + blocks * cw, 0);
  const countBits = (v) => (v <= 9 ? 8 : 16);
  const capacityBytes = (v) => Math.floor((dataCodewords(v) * 8 - 4 - countBits(v)) / 8);

  function chooseVersion(len) {
    for (let v = 1; v <= MAX_VERSION; v++) if (capacityBytes(v) >= len) return v;
    throw new Error(`QR: payload too long (${len} bytes, max ${capacityBytes(MAX_VERSION)})`);
  }

  // ---- Bit buffer -> data codewords
  function buildCodewords(bytes, version) {
    const bits = [];
    const push = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    push(0b0100, 4);
    push(bytes.length, countBits(version));
    for (const b of bytes) push(b, 8);
    const total = dataCodewords(version) * 8;
    push(0, Math.min(4, total - bits.length));
    while (bits.length % 8) bits.push(0);
    for (let pad = 0xec; bits.length < total; pad ^= 0xec ^ 0x11) push(pad, 8);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));

    // Split into blocks, add EC, interleave.
    const [ecLen, groups] = EC_M[version];
    const gen = rsGenerator(ecLen);
    const blocks = [];
    let k = 0;
    for (const [count, cw] of groups) for (let i = 0; i < count; i++) { blocks.push(data.slice(k, k + cw)); k += cw; }
    const ecs = blocks.map((b) => rsRemainder(b, gen));
    const out = [];
    const maxLen = Math.max(...blocks.map((b) => b.length));
    for (let i = 0; i < maxLen; i++) for (const b of blocks) if (i < b.length) out.push(b[i]);
    for (let i = 0; i < ecLen; i++) for (const e of ecs) out.push(e[i]);
    return out;
  }

  // ---- Matrix
  function alignmentPositions(v) {
    if (v === 1) return [];
    const num = Math.floor(v / 7) + 2;
    const size = v * 4 + 17;
    const step = v === 32 ? 26 : Math.ceil((v * 4 + 4) / (num * 2 - 2)) * 2;
    const res = [6];
    for (let pos = size - 7; res.length < num; pos -= step) res.splice(1, 0, pos);
    return res;   // ascending, e.g. v7 -> [6, 22, 38]
  }

  function encode(text, opts = {}) {
    const bytes = typeof text === 'string' ? Array.from(new TextEncoder().encode(text)) : Array.from(text);
    const version = opts.version || chooseVersion(bytes.length);
    if (version > MAX_VERSION || capacityBytes(version) < bytes.length) throw new Error('QR: version too small for payload');
    const size = version * 4 + 17;
    const modules = Array.from({ length: size }, () => new Uint8Array(size));
    const isFunc = Array.from({ length: size }, () => new Uint8Array(size));
    const set = (x, y, dark) => { modules[y][x] = dark ? 1 : 0; isFunc[y][x] = 1; };

    // Finder patterns + separators
    const finder = (cx, cy) => {
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        set(x, y, d !== 2 && d !== 4);
      }
    };
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
    // Timing
    for (let i = 8; i < size - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    // Alignment
    const ap = alignmentPositions(version);
    for (let i = 0; i < ap.length; i++) for (let j = 0; j < ap.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === ap.length - 1) || (i === ap.length - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ap[i] + dx, ap[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
    // Reserve format + version areas (values written after masking)
    const drawFormat = (mask) => {
      const data = (0b00 << 3) | mask;         // EC level M = 00
      let rem = data;
      for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      const bits = ((data << 10) | rem) ^ 0x5412;
      const bit = (i) => ((bits >>> i) & 1) === 1;
      for (let i = 0; i <= 5; i++) set(8, i, bit(i));
      set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
      for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
      for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
      for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
      set(8, size - 8, true);                    // dark module
    };
    drawFormat(0);
    if (version >= 7) {
      let rem = version;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const bits = (version << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const bit = ((bits >>> i) & 1) === 1;
        const a = size - 11 + (i % 3), b = Math.floor(i / 3);
        set(a, b, bit); set(b, a, bit);
      }
    }

    // Data placement (zigzag)
    const cw = buildCodewords(bytes, version);
    let bi = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (!isFunc[y][x] && bi < cw.length * 8) {
            modules[y][x] = (cw[bi >>> 3] >>> (7 - (bi & 7))) & 1;
            bi++;
          }
        }
      }
    }

    // Masking
    const MASKS = [
      (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
      (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
      (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
    ];
    const applyMask = (m) => {
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!isFunc[y][x] && MASKS[m](x, y)) modules[y][x] ^= 1;
    };
    const penalty = () => {
      let score = 0;
      const runPenalty = (getter) => {
        for (let a = 0; a < size; a++) {
          let run = 0, prev = -1;
          const hist = [0, 0, 0, 0, 0, 0, 0];
          for (let b = 0; b <= size; b++) {
            const v = b < size ? getter(a, b) : -1;
            if (v === prev) { run++; continue; }
            if (prev !== -1) {
              if (run >= 5) score += 3 + (run - 5);
              hist.shift(); hist.push(run);
              // finder-like: 1:1:3:1:1 dark/light with 4 light modules on a side
              if (prev === 0 && hist[1] === hist[3] && hist[1] === hist[4] && hist[1] === hist[5] && hist[2] === hist[1] * 3 && hist[1] > 0) {
                if (hist[0] >= 4 || run >= 4) score += 40;
              }
            }
            prev = v; run = 1;
          }
        }
      };
      runPenalty((a, b) => modules[a][b]);          // rows
      runPenalty((a, b) => modules[b][a]);          // columns
      for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
        const c = modules[y][x];
        if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) score += 3;
      }
      let dark = 0;
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) dark += modules[y][x];
      const total = size * size;
      const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
      return score + k * 10;
    };
    let mask = opts.mask == null ? undefined : Number(opts.mask);
    if (mask === undefined) {
      let best = Infinity;
      for (let m = 0; m < 8; m++) {
        applyMask(m); drawFormat(m);
        const p = penalty();
        if (p < best) { best = p; mask = m; }
        applyMask(m);
      }
    }
    applyMask(mask); drawFormat(mask);

    return {
      version, size, mask,
      get: (x, y) => modules[y][x] === 1,
      rows: () => modules.map((r) => Array.from(r)),
      _isFunction: (x, y) => isFunc[y][x] === 1,
    };
  }

  function toSvg(m, opts = {}) {
    const scale = opts.scale || 4, quiet = opts.quiet === undefined ? 4 : opts.quiet;
    const dim = (m.size + quiet * 2) * scale;
    let d = '';
    for (let y = 0; y < m.size; y++) for (let x = 0; x < m.size; x++) if (m.get(x, y)) d += `M${(x + quiet) * scale} ${(y + quiet) * scale}h${scale}v${scale}h-${scale}z`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${dim}" height="${dim}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="${opts.light || '#fff'}"/><path d="${d}" fill="${opts.dark || '#000'}"/></svg>`;
  }

  const api = { encode, toSvg, capacityBytes, MAX_VERSION, _codewords: buildCodewords };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.QR = api;
})(typeof window !== 'undefined' ? window : globalThis);
