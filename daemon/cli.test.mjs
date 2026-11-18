/**
 * Unit tests for the CLI-side cookie masking and argument mapping.
 * Run: node daemon/bin/cli.test.mjs
 */
import assert from 'node:assert/strict';
import { maskCookie, parseArgs, MASKED_PREFIX_LENGTH, traceArg } from './bin/cli.mjs';

// ── masking default ────────────────────────────────────────────────
const long = maskCookie({ name: 'sid', value: 'eyJhbGciOiJIUzI1NiJ9.payload.sig', domain: 'localhost', path: '/', secure: false, httpOnly: true }, false);
assert.equal(long.value, 'eyJhbG***', 'long value keeps first 6 chars + ***');
assert.equal(long.masked, true);
assert.equal(long.name, 'sid', 'metadata untouched');
assert.equal(long.domain, 'localhost');
assert.equal(long.path, '/');
assert.equal(long.httpOnly, true);

// ── ≤6 chars → just '***' ──────────────────────────────────────────
const short = maskCookie({ name: 's', value: 'abc' }, false);
assert.equal(short.value, '***');
assert.equal(short.masked, true);
const exactlySix = maskCookie({ name: 's', value: 'abcdef' }, false);
assert.equal(exactlySix.value, '***', 'value of exactly 6 chars is fully masked');
assert.equal(exactlySix.masked, true);

// ── empty value stays empty ────────────────────────────────────────
const empty = maskCookie({ name: 'e', value: '' }, false);
assert.equal(empty.value, '');
assert.equal(empty.masked, false);

// ── --show-values bypass ───────────────────────────────────────────
const raw = maskCookie({ name: 'sid', value: 'eyJhbGciOiJIUzI1NiJ9.payload.sig' }, true);
assert.equal(raw.value, 'eyJhbGciOiJIUzI1NiJ9.payload.sig');
assert.equal(raw.masked, false);

// ── MASKED_PREFIX_LENGTH contract ─────────────────────────────────
assert.equal(MASKED_PREFIX_LENGTH, 6);

// ── trace argument redaction ──────────────────────────────────────
assert.equal(traceArg('exec', 'document.title', { cmd: 'eval' }), 'document.title');
const evalArg = traceArg(
  'exec',
  "fetch('/x',{headers:{Authorization:'Bearer LEAKED'}})",
  { cmd: 'eval' },
);
assert.ok(!evalArg.includes('LEAKED'), 'eval trace arg redacts bearer tokens');
assert.match(evalArg, /REDACTED/);
assert.equal(traceArg('input', 'hunter2', { cmd: 'type' }), '<redacted:7>', 'typed input stores only its length');
const navArg = traceArg('navigate', 'https://example.com/cb?token=SECRET&ok=1', { cmd: 'open' });
assert.ok(!navArg.includes('SECRET'), 'URL query values are stripped from the trace');
assert.ok(navArg.includes('ok='), 'URL query parameter names survive');

// ── parseArgs maps the new flags ──────────────────────────────────
const { options } = parseArgs(['cookies', '--domain', 'localhost', '--show-values', '--json']);
assert.equal(options.domain, 'localhost');
assert.equal(options.showValues, true);
assert.equal(options.json, true);

const { options: o2 } = parseArgs(['tab', 'new', 'https://example.com', '--mute']);
assert.equal(o2.mute, true);

const { options: o3 } = parseArgs(['screenshot', '/tmp/a.png', '--restore']);
assert.equal(o3.restore, true);

// --url mapping
const { options: o4 } = parseArgs(['cookies', '--url', 'https://localhost/x']);
assert.equal(o4.url, 'https://localhost/x');
// ── direct-run guard survives symlinks ─────────────────────────────
// Regression: when invoked via a symlink (npm link / global bin), argv[1] is the
// symlink path while import.meta.url is the resolved real path, which used to
// make isDirectInvocation() false → main() never ran → silent exit 0.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('./bin/cli.mjs', import.meta.url));
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-bridge-cli-test-'));
const symlinkPath = path.join(tmpDir, 'tt-bridge');
fs.symlinkSync(cliPath, symlinkPath);
try {
  // `--help` exercises main() without requiring a running daemon, so this
  // guard test stays hermetic on CI runners.
  const direct = spawnSync(process.execPath, [cliPath, '--help'], { encoding: 'utf8' });
  assert.equal(direct.status, 0, `direct run exits 0: ${direct.stderr}`);
  assert.match(direct.stdout, /tt-bridge/, 'direct run prints help');

  const viaSymlink = spawnSync(process.execPath, [symlinkPath, '--help'], { encoding: 'utf8' });
  assert.equal(viaSymlink.status, 0, `symlink run exits 0: ${viaSymlink.stderr}`);
  assert.match(viaSymlink.stdout, /tt-bridge/, 'symlinked run prints help (guard resolves symlinks)');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log('cli.test.mjs: all assertions passed');
