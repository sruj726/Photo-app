'use strict';
/**
 * Server-side image processing on top of `sharp` – the one optional dependency.
 * Everything degrades gracefully when sharp is not installed: thumbnails then come from the
 * client only and HEIC files are stored as-is.
 */
let sharp = null;
try { sharp = require('sharp'); } catch { sharp = null; }

const THUMB_EDGE = 480;

const available = () => !!sharp;

/** JPEG thumbnail (long edge THUMB_EDGE), respecting EXIF orientation. */
async function thumbnail(buffer) {
  if (!sharp) throw new Error('sharp is not installed');
  return sharp(buffer, { failOn: 'none' }).rotate().resize({ width: THUMB_EDGE, height: THUMB_EDGE, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 72, mozjpeg: true }).toBuffer();
}

/** Re-encode any decodable image (HEIC, TIFF, …) as a browser-friendly JPEG, EXIF stripped, orientation applied. */
async function toJpeg(buffer, { maxEdge = 2560, quality = 88 } = {}) {
  if (!sharp) throw new Error('sharp is not installed');
  const img = sharp(buffer, { failOn: 'none' }).rotate().resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true });
  const out = await img.jpeg({ quality, mozjpeg: true }).toBuffer({ resolveWithObject: true });
  return { buffer: out.data, width: out.info.width, height: out.info.height };
}

async function dimensions(buffer) {
  if (!sharp) return null;
  try {
    const m = await sharp(buffer, { failOn: 'none' }).metadata();
    const swap = m.orientation >= 5;
    return { width: swap ? m.height : m.width, height: swap ? m.width : m.height };
  } catch { return null; }
}

module.exports = { available, thumbnail, toJpeg, dimensions, THUMB_EDGE };
