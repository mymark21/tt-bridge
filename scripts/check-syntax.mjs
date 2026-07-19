#!/usr/bin/env node
// CI syntax gate: `node --check` every first-party JS/MJS file.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [
  'x-cli/tt-bridge-cli/bin/daemon.mjs',
  'x-cli/tt-bridge-cli/bin/cli.mjs',
  'x-ext/tt-bridge-chrome-extension/dist/background.js',
  'x-ext/tt-bridge-chrome-extension/dist/assets/popup-BCbnAzCt.js',
  'test/daemon.test.mjs',
  'test/extension-logic.test.mjs',
];

let failed = 0;
for (const rel of files) {
  try {
    execFileSync(process.execPath, ['--check', path.join(root, rel)], { stdio: 'pipe' });
    console.log(`ok    ${rel}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL  ${rel}\n${error.stderr ? error.stderr.toString() : error.message}`);
  }
}
process.exit(failed ? 1 : 0);
