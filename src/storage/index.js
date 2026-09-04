'use strict';
/* Pick the storage backend from the environment: S3 when S3_ENDPOINT is set, local disk otherwise. */
const { createLocalStorage } = require('./local.js');
const { createS3Storage } = require('./s3.js');

function createStorage(dataDir) {
  if (process.env.S3_ENDPOINT) return createS3Storage();
  // Keys are "photos/<tripId>/<file>", so the local layout stays DATA_DIR/photos/… as before.
  return createLocalStorage(dataDir);
}

module.exports = { createStorage, createLocalStorage, createS3Storage };
