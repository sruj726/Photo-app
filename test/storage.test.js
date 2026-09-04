'use strict';
/* Storage backends: local disk, SigV4 against the AWS reference vector, and the S3 client against a fake S3 server. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createLocalStorage } = require('../src/storage/local.js');
const { createS3Storage, signV4, sha256hex } = require('../src/storage/s3.js');

test('local backend: put/get/size/stream/delete/deletePrefix + traversal guard', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-'));
  const s = createLocalStorage(dir);
  await s.put('photos/t1/a.jpg', Buffer.from('hello'));
  assert.equal((await s.get('photos/t1/a.jpg')).toString(), 'hello');
  assert.equal(await s.size('photos/t1/a.jpg'), 5);
  const st = await s.stream('photos/t1/a.jpg');
  assert.equal(st.size, 5);
  const chunks = []; for await (const c of st.stream) chunks.push(c);
  assert.equal(Buffer.concat(chunks).toString(), 'hello');
  assert.equal(await s.get('photos/t1/missing.jpg'), null);
  assert.equal(await s.stream('photos/t1/missing.jpg'), null);
  await s.delete('photos/t1/missing.jpg');   // no throw
  await s.put('photos/t1/b.jpg', Buffer.from('b'));
  await s.deletePrefix('photos/t1/');
  assert.equal(await s.get('photos/t1/b.jpg'), null);
  await assert.rejects(s.put('../escape.txt', Buffer.from('x')), /outside storage root/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('SigV4 matches the AWS documentation example (GET Object with Range)', () => {
  // https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-examples-using-sig-v4-signing.html
  const r = signV4({
    method: 'GET', path: '/test.txt', query: {},
    headers: { host: 'examplebucket.s3.amazonaws.com', range: 'bytes=0-9' },
    payloadHash: sha256hex(''), region: 'us-east-1',
    accessKey: 'AKIAIOSFODNN7EXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    date: new Date('2013-05-24T00:00:00Z'),
  });
  assert.equal(r.signature, 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  assert.match(r.headers.Authorization, /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20130524\/us-east-1\/s3\/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=/);
});

test('S3 backend against a fake S3 server (path style)', async () => {
  const objects = new Map();
  const seenAuth = [];
  const fake = http.createServer((req, res) => {
    seenAuth.push(req.headers.authorization || '');
    const url = new URL(req.url, 'http://x');
    const key = decodeURIComponent(url.pathname.replace(/^\/bucket\/?/, ''));
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (req.method === 'PUT') { objects.set(key, body); res.writeHead(200); return res.end(); }
      if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
        const prefix = url.searchParams.get('prefix') || '';
        const keys = [...objects.keys()].filter((k) => k.startsWith(prefix));
        res.writeHead(200, { 'content-type': 'application/xml' });
        return res.end(`<ListBucketResult>${keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join('')}</ListBucketResult>`);
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (!objects.has(key)) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'content-length': objects.get(key).length });
        return res.end(req.method === 'GET' ? objects.get(key) : undefined);
      }
      if (req.method === 'DELETE') { objects.delete(key); res.writeHead(204); return res.end(); }
      res.writeHead(400); res.end();
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const s = createS3Storage({ endpoint: `http://127.0.0.1:${fake.address().port}`, bucket: 'bucket', region: 'auto', accessKey: 'AK', secretKey: 'SK', pathStyle: true });
  await s.put('photos/t1/a b.jpg', Buffer.from('hello'));
  assert.equal((await s.get('photos/t1/a b.jpg')).toString(), 'hello');
  assert.equal(await s.size('photos/t1/a b.jpg'), 5);
  assert.equal(await s.get('photos/t1/nope.jpg'), null);
  const st = await s.stream('photos/t1/a b.jpg');
  const chunks = []; for await (const c of st.stream) chunks.push(c);
  assert.equal(Buffer.concat(chunks).toString(), 'hello');
  await s.put('photos/t1/c.jpg', Buffer.from('c'));
  await s.put('photos/t2/d.jpg', Buffer.from('d'));
  assert.deepEqual((await s.list('photos/t1/')).sort(), ['photos/t1/a b.jpg', 'photos/t1/c.jpg']);
  await s.deletePrefix('photos/t1/');
  assert.deepEqual(await s.list('photos/t1/'), []);
  assert.equal((await s.get('photos/t2/d.jpg')).toString(), 'd');
  assert.ok(seenAuth.every((a) => a.startsWith('AWS4-HMAC-SHA256 Credential=AK/')), 'every request is signed');
  fake.close();
});
