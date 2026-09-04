'use strict';
/**
 * S3-compatible storage backend (AWS S3, Cloudflare R2, MinIO, Backblaze B2) with a hand-rolled
 * AWS Signature Version 4 – no SDK. Same interface as the local backend.
 *
 *   S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com  S3_BUCKET=triplink
 *   S3_ACCESS_KEY=…  S3_SECRET_KEY=…  S3_REGION=auto  S3_PATH_STYLE=1
 */
const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');

const sha256hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const EMPTY_SHA = sha256hex('');

/** RFC 3986 encoding as S3 expects it (keeps "/" in paths when `keepSlash`). */
function uriEncode(str, keepSlash) {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%2F/g, keepSlash ? '/' : '%2F');
}

function amzDate(d = new Date()) {
  const iso = d.toISOString().replace(/[:-]|\.\d{3}/g, '');   // 20130524T000000Z
  return { amz: iso, date: iso.slice(0, 8) };
}

/**
 * Sign a request. Returns the headers to send (including Authorization).
 * `headers` must include host; `payloadHash` is the hex SHA-256 of the body (or UNSIGNED-PAYLOAD).
 */
function signV4({ method, path, query = {}, headers, payloadHash, region, service = 's3', accessKey, secretKey, date = new Date() }) {
  const { amz, date: day } = amzDate(date);
  const h = { ...headers, 'x-amz-date': amz, 'x-amz-content-sha256': payloadHash };
  const lower = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')]));
  const signedHeaders = Object.keys(lower).sort().join(';');
  const canonicalHeaders = Object.keys(lower).sort().map((k) => `${k}:${lower[k]}\n`).join('');
  const canonicalQuery = Object.keys(query).sort().map((k) => `${uriEncode(k)}=${uriEncode(String(query[k]))}`).join('&');
  const canonicalRequest = [method, uriEncode(path, true), canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amz, scope, sha256hex(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${secretKey}`, day);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  h.Authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { headers: h, signature, canonicalRequest, stringToSign };
}

function createS3Storage(opts = {}) {
  const endpoint = new URL(opts.endpoint || process.env.S3_ENDPOINT);
  const bucket = opts.bucket || process.env.S3_BUCKET;
  const region = opts.region || process.env.S3_REGION || 'us-east-1';
  const accessKey = opts.accessKey || process.env.S3_ACCESS_KEY;
  const secretKey = opts.secretKey || process.env.S3_SECRET_KEY;
  const pathStyle = opts.pathStyle !== undefined ? opts.pathStyle : process.env.S3_PATH_STYLE !== '0';
  if (!bucket || !accessKey || !secretKey) throw new Error('S3 storage needs S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY and S3_SECRET_KEY');
  const mod = endpoint.protocol === 'http:' ? http : https;
  const host = pathStyle ? endpoint.host : `${bucket}.${endpoint.host}`;
  const basePath = (endpoint.pathname.replace(/\/$/, '')) + (pathStyle ? `/${bucket}` : '');

  function request(method, key, { query = {}, body = null, stream = false } = {}) {
    const objectPath = key ? `${basePath}/${key.split('/').map(encodeURIComponent).join('/')}` : `${basePath}/`;
    const payloadHash = body ? sha256hex(body) : EMPTY_SHA;
    const headers = { host };
    if (body) headers['content-length'] = String(body.length);
    const { headers: signed } = signV4({ method, path: objectPath, query, headers, payloadHash, region, accessKey, secretKey });
    const qs = Object.keys(query).length ? `?${Object.keys(query).sort().map((k) => `${uriEncode(k)}=${uriEncode(String(query[k]))}`).join('&')}` : '';
    return new Promise((resolve, reject) => {
      const req = mod.request({ method, host: endpoint.hostname, port: endpoint.port || undefined, path: objectPath + qs, headers: signed }, (res) => {
        if (stream) return resolve({ status: res.statusCode, headers: res.headers, stream: res });
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      req.end(body);
    });
  }
  const fail = (op, r) => new Error(`S3 ${op} failed: HTTP ${r.status} ${r.body ? r.body.toString('utf8').slice(0, 200) : ''}`);

  return {
    kind: 's3',
    bucket,
    async put(key, data) {
      const r = await request('PUT', key, { body: Buffer.from(data) });
      if (r.status !== 200) throw fail('PUT', r);
    },
    async get(key) {
      const r = await request('GET', key);
      if (r.status === 404) return null;
      if (r.status !== 200) throw fail('GET', r);
      return r.body;
    },
    async size(key) {
      const r = await request('HEAD', key);
      if (r.status === 404) return null;
      if (r.status !== 200) throw fail('HEAD', r);
      return Number(r.headers['content-length']);
    },
    async stream(key) {
      const r = await request('GET', key, { stream: true });
      if (r.status === 404) { r.stream.resume(); return null; }
      if (r.status !== 200) { r.stream.resume(); throw new Error(`S3 GET failed: HTTP ${r.status}`); }
      return { stream: r.stream, size: Number(r.headers['content-length']) };
    },
    async delete(key) {
      const r = await request('DELETE', key);
      if (r.status !== 204 && r.status !== 200 && r.status !== 404) throw fail('DELETE', r);
    },
    async list(prefix) {
      const keys = [];
      let token;
      do {
        const query = { 'list-type': '2', prefix, ...(token ? { 'continuation-token': token } : {}) };
        const r = await request('GET', '', { query });
        if (r.status !== 200) throw fail('LIST', r);
        const xml = r.body.toString('utf8');
        for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"'));
        const next = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);
        token = next ? next[1] : null;
      } while (token);
      return keys;
    },
    async deletePrefix(prefix) {
      for (const k of await this.list(prefix)) await this.delete(k);
    },
  };
}

module.exports = { createS3Storage, signV4, uriEncode, sha256hex };
