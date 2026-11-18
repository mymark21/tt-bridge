// experience/store: filesystem primitives, layout paths, containment guard, raw ledger json
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import {
  HOST_RE,
  SLUG_RE,
} from './config.mjs';
import {
  now,
  sleepMs,
} from './util.mjs';

// ── paths ────────────────────────────────────────────────────────────

export function defaultExperienceDir(env = process.env) {
  const custom = env && env.TT_BRIDGE_EXPERIENCE_DIR;
  if (custom && String(custom).trim()) return path.resolve(String(custom).trim());
  return path.join(os.homedir(), '.agents', 'skills', 'tt-bridge', 'experience');
}



export function entryFile(root, id) {
  const parts = String(id || '').split('/');
  if (parts.length !== 2) {
    throw new Error(`Invalid experience id "${id}" (expected "<host>/<slug>")`);
  }
  const [host, slug] = parts;
  if (!HOST_RE.test(host) || host.includes('..') || !SLUG_RE.test(slug) || slug.includes('..')) {
    throw new Error(`Invalid experience id "${id}" (expected "<host>/<slug>")`);
  }
  const base = path.resolve(root);
  const file = path.resolve(base, host, slug, 'entry.md');
  if (file !== path.join(base, host, slug, 'entry.md') || !file.startsWith(base + path.sep)) {
    throw new Error(`Refusing to resolve experience id "${id}" outside the experience root`);
  }
  assertInsideRoot(base, file);
  return file;
}



export function slugFromId(id) {
  return String(id).split('/')[1];
}



function ledgerPath(root) {
  return path.join(root, '_ledger', 'attempts.json');
}



export function atomicWrite(file, content) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  let mode = 0o600;
  try { mode = fs.statSync(file).mode & 0o777; } catch { /* new file */ }
  const tmp = path.join(dir, `.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
  const fd = fs.openSync(tmp, 'wx', mode);
  try {
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw error;
  }
  try {
    const dfd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
  } catch { /* directory fsync is best-effort */ }
}



/**
 * Run fn while holding a simple O_EXCL lock file. Concurrent CLI calls
 * serialize ledger updates instead of losing attempts.
 */
export function withLedgerLock(root, fn) {
  const dir = path.join(root, '_ledger');
  fs.mkdirSync(dir, { recursive: true });
  assertInsideRoot(root, dir);
  const lock = path.join(dir, 'attempts.lock');
  assertInsideRoot(root, lock);
  const started = Date.now();
  let fd = null;
  while (fd === null) {
    try {
      fd = fs.openSync(lock, 'wx');
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const stat = fs.statSync(lock);
        if (Date.now() - stat.mtimeMs > 10_000) fs.unlinkSync(lock);
      } catch {
        // Lock disappeared; retry immediately.
      }
      if (Date.now() - started > 2000) {
        throw new Error(`Experience ledger is locked: ${lock}`);
      }
      sleepMs(25);
    }
  }
  try {
    fs.writeSync(fd, String(process.pid));
    return fn();
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
    try { fs.unlinkSync(lock); } catch { /* ignore */ }
  }
}



/**
 * Resolve a path and reject anything that escapes the experience root via
 * `..` or a symlinked host/entry directory. The nearest existing ancestor is
 * resolved, so this also covers paths that do not exist yet.
 */
export function assertInsideRoot(root, target) {
  const base = path.resolve(root);
  const resolved = path.resolve(target);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error(`Refusing to access ${target} outside the experience root`);
  }
  if (!fs.existsSync(base)) return resolved;
  const rootReal = fs.realpathSync(base);
  let probe = resolved;
  while (!fs.existsSync(probe) && probe !== path.dirname(probe)) probe = path.dirname(probe);
  const realProbe = fs.realpathSync(probe);
  const real = path.join(realProbe, path.relative(probe, resolved));
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
    throw new Error(`Refusing to access ${target} outside the experience root (symlink escape)`);
  }
  return real;
}



export function hostIndexPath(root, host) {
  const safeHost = String(host || '').trim().toLowerCase();
  return path.join(path.resolve(root), '_index', `${safeHost}.json`);
}



// ── ledger ───────────────────────────────────────────────────────────

export function loadLedger(root) {
  const file = ledgerPath(root);
  if (!fs.existsSync(file)) return { version: 1, updated: null, keys: {} };
  assertInsideRoot(root, file);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid experience ledger at ${file}: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid experience ledger at ${file}: expected an object`);
  }
  const keys = parsed.keys && typeof parsed.keys === 'object' ? parsed.keys : {};
  for (const k of Object.keys(keys)) {
    const rec = keys[k];
    if (rec && typeof rec === 'object') {
      if (rec.errclass === undefined) {
        rec.errclass = rec.lastResult === 'miss' ? 'page' : null;
      }
      if (Array.isArray(rec.history)) {
        for (const item of rec.history) {
          if (item && typeof item === 'object' && item.result === 'miss' && item.errclass === undefined) {
            item.errclass = 'page';
          }
        }
      }
    }
  }
  return {
    version: parsed.version || 1,
    updated: parsed.updated || null,
    keys,
  };
}



export function saveLedger(root, ledger) {
  const payload = {
    version: 1,
    updated: now(),
    keys: (ledger && ledger.keys) || {},
  };
  assertInsideRoot(root, ledgerPath(root));
  atomicWrite(ledgerPath(root), `${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}

/**
 * Resolve an entry's assert.js without leaving the experience root.
 *
 * This is the single choke point for "run a stored assertion". It is what keeps
 * a poisoned index bucket or a shared playbook with a hostile frontmatter id
 * from naming a file outside the store: the id is re-validated with the same
 * rules as entryFile(), then the result is containment-checked.
 *
 * Returns the absolute path, or null when the entry has no usable assertion.
 * Throws only on a hostile id (callers treat that as "no assertion").
 */
export function resolveEntryAssert(root, id) {
  const parts = String(id || '').split('/');
  if (parts.length !== 2) return null;
  const [host, slug] = parts;
  if (!HOST_RE.test(host) || host.includes('..')) return null;
  if (!SLUG_RE.test(slug) || slug.includes('..')) return null;
  const base = path.resolve(root);
  const target = path.resolve(base, host, slug, 'assert.js');
  if (target !== path.join(base, host, slug, 'assert.js')) return null;
  if (!target.startsWith(base + path.sep)) return null;
  try {
    assertInsideRoot(base, target);
  } catch {
    return null;
  }
  return fs.existsSync(target) ? target : null;
}
