#!/usr/bin/env node
// Stand-in for ml/people.py in tests: "counts" people from the file size so results are deterministic.
const fs = require('node:fs');
const size = fs.statSync(process.argv[2]).size;
if (process.env.FAKE_TAGGER_FAIL === '1') { console.error('boom'); process.exit(1); }
console.log(JSON.stringify({ people: process.env.FAKE_TAGGER_PEOPLE ? Number(process.env.FAKE_TAGGER_PEOPLE) : size % 5, model: 'fake' }));
