#!/usr/bin/env node
'use strict';

const { main } = require('../src/cli');

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code || 0;
  })
  .catch((err) => {
    process.stderr.write(String(err && err.stack ? err.stack : err) + '\n');
    process.exitCode = 1;
  });
