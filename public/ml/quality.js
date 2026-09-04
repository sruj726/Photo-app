/* Image quality heuristics, pure functions (browser + Node).
 *   sharpness(gray, w, h)         variance of the Laplacian – higher = sharper
 *   toGray(rgba, w, h)            RGBA Uint8ClampedArray -> Float32Array luminance
 *   groupBursts(photos, gapMs)    same member, shots within gapMs -> one "burst"; picks the sharpest as best
 */
(function (root) {
  'use strict';

  function toGray(rgba, w, h) {
    const g = new Float32Array(w * h);
    for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
    return g;
  }

  /** Variance of the 4-neighbour Laplacian over the interior. Blurry images score low (< ~30), crisp ones high. */
  function sharpness(gray, w, h) {
    if (w < 3 || h < 3) return 0;
    let sum = 0, sumSq = 0, n = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
        sum += lap; sumSq += lap * lap; n++;
      }
    }
    const mean = sum / n;
    return Math.max(0, sumSq / n - mean * mean);
  }

  /** Sharpness of an ImageData-like object {data, width, height}. */
  function sharpnessOfImageData(img) {
    return sharpness(toGray(img.data, img.width, img.height), img.width, img.height);
  }

  /**
   * Group photos into bursts: consecutive shots by the same member taken within gapMs of each other.
   * Input must be sorted newest first (as the gallery has it). Returns [{ items, best }] preserving order.
   * `best` is the sharpest item when sharpness is known, else the first.
   */
  function groupBursts(photos, gapMs = 3000) {
    const groups = [];
    let cur = null;
    for (const p of photos) {
      if (p.kind === 'video') { if (cur) { groups.push(cur); cur = null; } groups.push({ items: [p], best: p }); continue; }
      const t = p.takenAt || p.createdAt || 0;
      if (cur && cur.memberId === p.memberId && Math.abs(cur.lastT - t) <= gapMs) { cur.items.push(p); cur.lastT = t; }
      else { if (cur) groups.push(cur); cur = { items: [p], memberId: p.memberId, lastT: t }; }
    }
    if (cur) groups.push(cur);
    for (const g of groups) {
      if (g.best) continue;
      g.best = g.items.reduce((b, p) => ((p.sharpness || 0) > (b.sharpness || 0) ? p : b), g.items[0]);
      delete g.memberId; delete g.lastT;
    }
    return groups;
  }

  const api = { toGray, sharpness, sharpnessOfImageData, groupBursts };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.TLQuality = api;
})(typeof window !== 'undefined' ? window : globalThis);
