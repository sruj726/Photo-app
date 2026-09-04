/* "Photos of me" – everything runs on the device, nothing about faces is sent anywhere.
 *
 * Pipeline: detect faces -> crop -> embed -> cosine similarity to the selfie embedding.
 *
 * Detection uses the browser's Shape Detection API (`FaceDetector`, Chrome on Android/macOS) when present.
 * Embedding is pluggable: `setEmbedder(fn)` accepts an async (imageData) -> Float32Array from a real model
 * (e.g. an ONNX face-recognition net via onnxruntime-web dropped into /models/). The built-in fallback is a
 * small illumination-normalised 24×24 grayscale descriptor – enough to find the same person across a few
 * photos of one trip, not a biometric system. Results are cached per photo in IndexedDB by the caller.
 */
(function (root) {
  'use strict';
  const SIDE = 24;

  /** Fallback descriptor: crop -> SIDE×SIDE gray -> zero-mean, unit-norm. Works on {data,width,height}. */
  function fallbackEmbed(img) {
    const { data, width, height } = img;
    const out = new Float32Array(SIDE * SIDE);
    for (let y = 0; y < SIDE; y++) {
      for (let x = 0; x < SIDE; x++) {
        // box-sample the source region for this cell
        const x0 = Math.floor((x / SIDE) * width), x1 = Math.max(x0 + 1, Math.floor(((x + 1) / SIDE) * width));
        const y0 = Math.floor((y / SIDE) * height), y1 = Math.max(y0 + 1, Math.floor(((y + 1) / SIDE) * height));
        let sum = 0, n = 0;
        for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { const i = (yy * width + xx) * 4; sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]; n++; }
        out[y * SIDE + x] = sum / n;
      }
    }
    return normalise(out);
  }
  function normalise(v) {
    let mean = 0; for (const x of v) mean += x; mean /= v.length;
    let norm = 0; for (let i = 0; i < v.length; i++) { v[i] -= mean; norm += v[i] * v[i]; }
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < v.length; i++) v[i] /= norm;
    return v;
  }
  function cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
  }

  let embedder = async (img) => fallbackEmbed(img);
  const setEmbedder = (fn) => { embedder = fn; };
  const embedderName = () => (embedder.name === 'fallback' || embedder.length === 1 ? 'fallback-24x24' : 'custom');

  /** Face boxes [{x,y,width,height}] – Shape Detection API when available, else the centre square (whole-image fallback). */
  async function detectFaces(source, w, h) {
    if (typeof root.FaceDetector === 'function') {
      try {
        const det = new root.FaceDetector({ fastMode: true, maxDetectedFaces: 10 });
        const faces = await det.detect(source);
        if (faces.length) return faces.map((f) => ({ x: f.boundingBox.x, y: f.boundingBox.y, width: f.boundingBox.width, height: f.boundingBox.height }));
      } catch { /* fall through */ }
    }
    const s = Math.min(w, h);
    return [{ x: (w - s) / 2, y: (h - s) / 2, width: s, height: s, wholeImage: true }];
  }

  /** Browser helper: embeddings for every face in a drawable source (img/video/canvas/bitmap). */
  async function embedFaces(source, w, h) {
    const boxes = await detectFaces(source, w, h);
    const canvas = root.document ? root.document.createElement('canvas') : null;
    if (!canvas) throw new Error('embedFaces needs a DOM canvas');
    const out = [];
    for (const b of boxes) {
      const size = 96;
      canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(source, b.x, b.y, b.width, b.height, 0, 0, size, size);
      out.push({ box: b, embedding: await embedder(ctx.getImageData(0, 0, size, size)) });
    }
    return out;
  }

  /** Match score of a photo: best cosine among its faces vs the selfie embedding. */
  function bestMatch(faceEmbeddings, selfie) {
    let best = -1;
    for (const f of faceEmbeddings) best = Math.max(best, cosine(f.embedding || f, selfie));
    return best;
  }

  const DEFAULT_THRESHOLD = 0.72;
  const api = { SIDE, fallbackEmbed, normalise, cosine, setEmbedder, embedderName, detectFaces, embedFaces, bestMatch, DEFAULT_THRESHOLD };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.TLFace = api;
})(typeof window !== 'undefined' ? window : globalThis);
