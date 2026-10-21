#!/usr/bin/env node
import { main } from '../src/cli.js';

// `stickypatch status | head` should not crash with EPIPE.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error) => {
    if (error.code === 'EPIPE') process.exit(process.exitCode ?? 0);
    throw error;
  });
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`stickypatch crashed: ${error.stack || error}\n`);
    process.exitCode = 2;
  },
);
