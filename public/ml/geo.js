/* Map maths, pure functions (browser + Node).
 *   project(lat, lng, zoom)          -> {x, y} in world pixels (Web Mercator, 256px tiles)
 *   fitBounds(points, w, h)          -> {zoom, center}
 *   cluster(points, radiusPx, zoom)  -> [{lat, lng, items}] greedy pixel-distance clustering
 *   clusterByDay(points)             -> Map dayKey -> points
 *   tileUrl(z, x, y)                 -> OpenStreetMap tile URL (only fetched when the map is opened, opt-in)
 */
(function (root) {
  'use strict';
  const TILE = 256;
  const clampLat = (lat) => Math.max(-85.05112878, Math.min(85.05112878, lat));

  function project(lat, lng, zoom) {
    const scale = TILE * Math.pow(2, zoom);
    const x = ((lng + 180) / 360) * scale;
    const s = Math.sin((clampLat(lat) * Math.PI) / 180);
    const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale;
    return { x, y };
  }
  function unproject(x, y, zoom) {
    const scale = TILE * Math.pow(2, zoom);
    const lng = (x / scale) * 360 - 180;
    const n = Math.PI - (2 * Math.PI * y) / scale;
    const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    return { lat, lng };
  }

  /** Smallest integer zoom (0..18) at which all points fit into w×h pixels with padding. */
  function fitBounds(points, w, h, padding = 40) {
    if (!points.length) return { zoom: 2, center: { lat: 0, lng: 0 } };
    const lats = points.map((p) => p.lat), lngs = points.map((p) => p.lng);
    const center = { lat: (Math.min(...lats) + Math.max(...lats)) / 2, lng: (Math.min(...lngs) + Math.max(...lngs)) / 2 };
    for (let zoom = 18; zoom >= 0; zoom--) {
      const a = project(Math.max(...lats), Math.min(...lngs), zoom), b = project(Math.min(...lats), Math.max(...lngs), zoom);
      if (Math.abs(b.x - a.x) + 2 * padding <= w && Math.abs(b.y - a.y) + 2 * padding <= h) return { zoom, center };
    }
    return { zoom: 0, center };
  }

  /** Greedy clustering: points within radiusPx (at the given zoom) of a cluster's first point join it. */
  function cluster(points, radiusPx, zoom) {
    const out = [];
    for (const p of points) {
      const pp = project(p.lat, p.lng, zoom);
      let hit = null;
      for (const c of out) { const cp = project(c.lat, c.lng, zoom); if (Math.hypot(cp.x - pp.x, cp.y - pp.y) <= radiusPx) { hit = c; break; } }
      if (hit) { hit.items.push(p); hit.lat = hit.items.reduce((s, q) => s + q.lat, 0) / hit.items.length; hit.lng = hit.items.reduce((s, q) => s + q.lng, 0) / hit.items.length; }
      else out.push({ lat: p.lat, lng: p.lng, items: [p] });
    }
    return out;
  }

  function dayKey(ms) { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
  function clusterByDay(points) {
    const m = new Map();
    for (const p of points) { const k = dayKey(p.takenAt || p.createdAt || 0); if (!m.has(k)) m.set(k, []); m.get(k).push(p); }
    return m;
  }

  const tileUrl = (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;

  const api = { TILE, project, unproject, fitBounds, cluster, clusterByDay, dayKey, tileUrl };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.TLGeo = api;
})(typeof window !== 'undefined' ? window : globalThis);
