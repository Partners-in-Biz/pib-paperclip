#!/usr/bin/env node
'use strict';
const { run } = require('../src/evidence.cjs');

run(process.argv.slice(2), process.env).then((code) => {
  process.exitCode = code;
}).catch((err) => {
  console.error('Fatal error:', err.message);
  process.exitCode = 1;
});
