'use strict';
/* Small HTTP + validation helpers shared by the server modules. */
const crypto = require('node:crypto');

const MAX_JSON_BYTES = 64 * 1024;
const DAY_MS = 86400000;
const ID_RE = /^[0-9a-f-]{36}$/;
const CODE_RE = /^[a-z0-9]{6,16}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no 0/o/1/l/i ambiguity

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function randomCode(len = 10) {
  const bytes = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return s;
}
const newId = () => crypto.randomUUID();
const newToken = () => crypto.randomBytes(24).toString('base64url');
const now = () => Date.now();

function sendJson(res, status, body, extraHeaders = {}) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(data);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > limit) {
        reject(new HttpError(413, `Body exceeds ${limit} bytes`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req, MAX_JSON_BYTES);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); }
  catch { throw new HttpError(400, 'Invalid JSON body'); }
}

function cleanName(raw, fallback) {
  const s = String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60);
  return s || fallback;
}

function cleanDate(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const s = String(raw);
  if (!DATE_RE.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) throw new HttpError(400, 'Dates must be YYYY-MM-DD');
  return s;
}

/** Sniff the real image type from magic bytes – never trust the header alone. */
function sniffImage(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { mime: 'image/png', ext: 'png' };
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  const ftyp = buf.toString('ascii', 4, 8);
  if (ftyp === 'ftyp') {
    const brand = buf.toString('ascii', 8, 12);
    if (/^(heic|heix|hevc|mif1|msf1)$/.test(brand)) return { mime: 'image/heic', ext: 'heic' };
    if (/^(avif|avis)$/.test(brand)) return { mime: 'image/avif', ext: 'avif' };
  }
  return null;
}

module.exports = {
  HttpError, sendJson, readBody, readJson, cleanName, cleanDate, sniffImage,
  randomCode, newId, newToken, now, ID_RE, CODE_RE, DAY_MS, MAX_JSON_BYTES,
};
