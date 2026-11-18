// experience/exec: execute stored assertion files and scripts
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  entryId,
  normalizeUrl,
  urlParts,
} from './identity.mjs';
import {
  recordAttempt,
} from './ledger.mjs';
import {
  assertInsideRoot,
  entryFile,
} from './store.mjs';
import {
  readEntry,
} from './entry.mjs';
import {
  isSafeRelativeFilename,
  tail,
} from './util.mjs';

// ── execution ────────────────────────────────────────────────────────

function resolveInterpreter(scriptPath) {
  try {
    const firstLine = fs.readFileSync(scriptPath, 'utf8').split(/\r?\n/, 1)[0] || '';
    const mode = fs.statSync(scriptPath).mode;
    if (firstLine.startsWith('#!') && (mode & 0o111)) {
      // Execute the script itself; the interpreter comes from its shebang.
      return { command: scriptPath, commandArgs: [] };
    }
  } catch {
    // Fall back to python3.
  }
  return { command: process.env.TT_BRIDGE_PYTHON || 'python3', commandArgs: [scriptPath] };
}



/**
 * Run an entry's script under the documented contract. A zero exit records a
 * hit; any other exit records a miss with a stderr tail. Returns the script's
 * exit code so the CLI can propagate it.
 */
export function runEntry(root, id, opts = {}) {
  const entry = readEntry(entryFile(root, id));
  if (entry.status !== 'verified' && !opts.force) {
    return {
      ok: false,
      exitCode: 2,
      entryId: entry.id,
      stdout: '',
      stderr: '',
      data: null,
      error: `Entry ${id} is ${entry.status}; only verified entries run automatically (use --force after review)`,
      recorded: null,
    };
  }
  if (!entry.script) {
    return {
      ok: false,
      exitCode: 2,
      entryId: entry.id,
      stdout: '',
      stderr: '',
      data: null,
      error: `Entry ${id} has no script`,
      recorded: null,
    };
  }
  const scriptPath = path.join(entry.dir, entry.script);
  if (!isSafeRelativeFilename(entry.script)) {
    return {
      ok: false,
      exitCode: 2,
      entryId: entry.id,
      stdout: '',
      stderr: '',
      data: null,
      error: `Unsafe script path: ${entry.script}`,
      recorded: null,
    };
  }
  try {
    assertInsideRoot(root, scriptPath);
  } catch (error) {
    return {
      ok: false,
      exitCode: 2,
      entryId: entry.id,
      stdout: '',
      stderr: '',
      data: null,
      error: error.message,
      recorded: null,
    };
  }
  if (!fs.existsSync(scriptPath)) {
    return {
      ok: false,
      exitCode: 2,
      entryId: entry.id,
      stdout: '',
      stderr: '',
      data: null,
      error: `Script not found: ${entry.script}`,
      recorded: null,
    };
  }

  const url = opts.url ? normalizeUrl(opts.url) : entry.url;
  const extraArgs = Array.isArray(opts.args) ? opts.args.map(String) : [];
  const { command, commandArgs } = resolveInterpreter(scriptPath);
  // detached + process-group kill: a timed-out script may have spawned children
  // (the documented pattern is `execSync('tt-bridge ...')`), and killing only the
  // direct child would leave them holding the browser session.
  const result = spawnSync(command, [...commandArgs, '--url', url, ...extraArgs], {
    cwd: entry.dir,
    detached: true,
    killSignal: 'SIGKILL',
    env: {
      ...process.env,
      TT_BRIDGE_URL: url,
      TT_BRIDGE_ENTRY_ID: entry.id,
      TT_BRIDGE_EXPERIENCE_DIR: path.resolve(root),
    },
    encoding: 'utf8',
    timeout: opts.timeout ?? 120_000,
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.error && result.error.code === 'ETIMEDOUT' && result.pid) {
    try { process.kill(-result.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  let exitCode;
  if (result.error) {
    // Align with `experience end`: env faults exit 3.
    exitCode = result.error.code === 'ETIMEDOUT' ? 3 : 2;
  } else if (result.status === null) {
    exitCode = 1;
  } else {
    exitCode = result.status;
  }

  let data = null;
  if (stdout.trim()) {
    try { data = JSON.parse(stdout); } catch { data = null; }
  }

  // A script that hit its time budget says nothing about the page: it is an
  // environment fault, exactly like an assertion timeout in `end`.
  const timedOut = Boolean(result.error && result.error.code === 'ETIMEDOUT');
  const recorded = opts.record === false ? null : recordAttempt(root, {
    url: urlParts(url).host === urlParts(entry.url).host ? url : entry.url,
    intent: entry.slug,
    result: exitCode === 0 ? 'hit' : 'miss',
    error: exitCode === 0 ? null : tail(stderr || (result.error ? result.error.message : `exit ${exitCode}`)),
    errclass: timedOut ? 'env' : undefined,
    id: entry.id,
    autoCapture: false,
  });

  return {
    ok: exitCode === 0,
    exitCode,
    entryId: entry.id,
    stdout,
    stderr,
    data,
    error: result.error ? result.error.message : null,
    recorded,
  };
}



export const ASSERT_RUNNER = `
const fs = require('node:fs');
const path = require('node:path');
const target = process.argv[1];
let code;
try {
  code = fs.readFileSync(target, 'utf8');
} catch (err) {
  process.stderr.write('assert-error: cannot read file: ' + err.message);
  process.exit(10);
}
let fn;
try {
  fn = new Function('require', '__filename', '__dirname', code);
} catch (err) {
  process.stderr.write('assert-error: syntax error: ' + err.message);
  process.exit(11);
}
// Relative require() inside an assertion resolves against the assertion file,
// not the caller's cwd (the CLI may run from anywhere).
let req;
try {
  req = require('node:module').createRequire(target);
} catch {
  req = require;
}
let res;
try {
  res = fn(req, target, path.dirname(target));
} catch (err) {
  process.stderr.write('assert-error: runtime error: ' + err.message);
  process.exit(12);
}
if (res && typeof res.then === 'function') {
  process.stderr.write('assert-error: assertion returned a Promise (must be synchronous)');
  process.exit(13);
}
if (res === true) {
  process.exit(0);
} else {
  const msg = typeof res === 'string' ? res : (res === false ? 'assertion returned false' : 'assertion returned ' + JSON.stringify(res));
  process.stderr.write(msg);
  process.exit(1);
}
`;



export function formatAssertError(msg) {
  const str = String(msg || '').trim();
  if (!str) return 'assert-error: unknown error';
  return str.startsWith('assert-error:') ? str : `assert-error: ${str}`;
}

/**
 * Run a stored assertion file and classify the outcome as exactly one of:
 *   'ok'      — the file returned true
 *   'failed'  — it ran and returned false / threw
 *   'timeout' — it exceeded the budget and had to be killed
 *
 * Lazy verification must not demote an entry because the sandbox was slow or
 * because an assertion ignored SIGTERM, so a timeout is its own outcome and the
 * child is killed with SIGKILL after `timeoutMs` (a script that installs a
 * SIGTERM handler would otherwise outlive spawnSync's default signal and hang
 * the caller forever).
 */
export function runLazyAssert(assertFile, { timeoutMs = 5000 } = {}) {
  const child = spawnSync(process.execPath, ['-e', ASSERT_RUNNER, assertFile], {
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    env: { ...process.env, TT_BRIDGE_EXPERIENCE_DIR: process.env.TT_BRIDGE_EXPERIENCE_DIR },
  });
  const timedOut = Boolean(child.error && child.error.code === 'ETIMEDOUT')
    || child.signal === 'SIGKILL'
    || child.signal === 'SIGTERM';
  if (timedOut) return 'timeout';
  return child.status === 0 ? 'ok' : 'failed';
}
