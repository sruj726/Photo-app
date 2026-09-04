'use strict';
/* Local-disk storage backend. Keys look like "photos/<tripId>/<photoId>.jpg". */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

function createLocalStorage(rootDir) {
  const root = path.resolve(rootDir);
  fs.mkdirSync(root, { recursive: true });
  const resolve = (key) => {
    const p = path.normalize(path.join(root, key));
    if (!p.startsWith(root + path.sep) && p !== root) throw new Error(`Refusing key outside storage root: ${key}`);
    return p;
  };
  return {
    kind: 'local',
    root,
    async put(key, data) {
      const p = resolve(key);
      await fsp.mkdir(path.dirname(p), { recursive: true });
      await fsp.writeFile(p, data);
    },
    async get(key) {
      try { return await fsp.readFile(resolve(key)); } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
    },
    async size(key) {
      try { return (await fsp.stat(resolve(key))).size; } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
    },
    async stream(key) {
      const p = resolve(key);
      let st;
      try { st = await fsp.stat(p); } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
      return { stream: fs.createReadStream(p), size: st.size };
    },
    async delete(key) {
      await fsp.rm(resolve(key), { force: true });
    },
    async deletePrefix(prefix) {
      // Prefixes are always "photos/<tripId>/" style directories here.
      await fsp.rm(resolve(prefix.replace(/\/$/, '')), { recursive: true, force: true });
    },
  };
}

module.exports = { createLocalStorage };
