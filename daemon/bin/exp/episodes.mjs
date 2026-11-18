// experience/episodes: begin/end transaction
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_CAPTURE_AFTER,
  DEFAULT_MISS_THRESHOLD,
  SCHEMA_VERSION,
} from './config.mjs';
import {
  ASSERT_RUNNER,
  formatAssertError,
} from './exec.mjs';
import {
  classifyError,
  normalizeIntent,
  normalizeUrl,
  redactError,
} from './identity.mjs';
import {
  recordAttempt,
} from './ledger.mjs';
import {
  assertInsideRoot,
  atomicWrite,
  loadLedger,
} from './store.mjs';
import {
  isSafeRelativeFilename,
  now,
} from './util.mjs';

// ── episode transactions (begin / end) ───────────────────────────────

export function episodePath(root, sessionId) {
  const session = String(sessionId || '').trim();
  if (!session || !isSafeRelativeFilename(session) || !isSafeRelativeFilename(`${session}.json`)) {
    const err = new Error(`Invalid session id "${sessionId}"`);
    err.exitCode = 2;
    throw err;
  }
  const base = path.resolve(root);
  const file = path.resolve(base, '_episodes', `${session}.json`);
  assertInsideRoot(base, file);
  return file;
}



export function loadEpisode(root, sessionId) {
  const file = episodePath(root, sessionId);
  if (!fs.existsSync(file)) {
    const err = new Error(`Episode state file not found for session "${sessionId}"`);
    err.exitCode = 2;
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    const err = new Error(`Invalid episode state file at ${file}: ${error.message}`);
    err.exitCode = 2;
    throw err;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const err = new Error(`Invalid episode state file at ${file}: expected an object`);
    err.exitCode = 2;
    throw err;
  }
  return { episode: parsed, file };
}



// Episodes are transaction state, not history: one that was never settled is
// garbage after a day. Sweeping on begin keeps _episodes/ from growing forever
// without needing a separate prune command.
const EPISODE_TTL_MS = 24 * 60 * 60 * 1000;

function sweepStaleEpisodes(root) {
  const dir = path.join(path.resolve(root), '_episodes');
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - EPISODE_TTL_MS;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const file = path.join(dir, name);
      if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
    } catch { /* best effort */ }
  }
}

export function beginEpisode(root, opts = {}) {
  const { url, intent, session } = opts;
  if (!url || !String(url).trim()) {
    const err = new Error('experience begin requires --url <url>');
    err.exitCode = 2;
    throw err;
  }
  if (!intent || !String(intent).trim()) {
    const err = new Error('experience begin requires --intent <slug>');
    err.exitCode = 2;
    throw err;
  }
  sweepStaleEpisodes(root);
  let normalizedUrl;
  try {
    normalizedUrl = normalizeUrl(url);
  } catch (error) {
    // A malformed --url is a usage error (2), not an internal failure (1).
    const err = new Error(error.message);
    err.exitCode = 2;
    throw err;
  }
  const normalizedIntent = normalizeIntent(intent);
  const sessionId = (session && String(session).trim()) || randomUUID();
  const stateFile = episodePath(root, sessionId);

  const payload = {
    schema: SCHEMA_VERSION,
    session: sessionId,
    url: normalizedUrl,
    intent: normalizedIntent,
    startedAt: now(),
    steps: [],
  };

  atomicWrite(stateFile, `${JSON.stringify(payload, null, 2)}\n`);

  return {
    session: sessionId,
    url: normalizedUrl,
    intent: normalizedIntent,
    stateFile,
  };
}



export function endEpisode(root, opts = {}) {
  const {
    session,
    assert: assertFile,
    error: explicitError,
    threshold = DEFAULT_MISS_THRESHOLD,
    captureAfter = DEFAULT_CAPTURE_AFTER,
    autoCapture = true,
    errclass: explicitClass,
  } = opts;

  if (!session || !String(session).trim()) {
    const err = new Error('experience end requires --session <id>');
    err.exitCode = 2;
    throw err;
  }
  if (!assertFile && explicitError === undefined) {
    const err = new Error('experience end requires --assert <file> or --error <msg>');
    err.exitCode = 2;
    throw err;
  }
  // --error intentionally wins over --assert (documented): the caller already
  // knows the operation failed and does not want to pay for an assertion. The
  // errclass for that path must be explicit or text-derived, never silently
  // "trusted" — see the errclass resolution below.

  const { episode, file: stateFile } = loadEpisode(root, session);

  let result;
  let attemptError = null;

  if (explicitError !== undefined && explicitError !== null) {
    result = 'miss';
    attemptError = String(explicitError);
  } else {
    const resolvedAssertPath = path.resolve(assertFile);
    if (!fs.existsSync(resolvedAssertPath)) {
      result = 'miss';
      attemptError = formatAssertError(`assertion file not found: ${assertFile}`);
    } else {
      const child = spawnSync(process.execPath, ['-e', ASSERT_RUNNER, resolvedAssertPath], {
        encoding: 'utf8',
        timeout: 5000,
        // An assertion may install a SIGTERM handler; SIGKILL is the only
        // signal that guarantees the 5s budget is real.
        killSignal: 'SIGKILL',
        env: { ...process.env, TT_BRIDGE_EXPERIENCE_DIR: root },
      });

      if (child.error && (child.error.code === 'ETIMEDOUT' || child.signal === 'SIGTERM' || child.signal === 'SIGKILL')) {
        result = 'miss';
        attemptError = 'assert-error: assertion timed out after 5000ms';
      } else if (child.error) {
        result = 'miss';
        attemptError = formatAssertError(child.error.message);
      } else if (child.status === 0) {
        result = 'hit';
        attemptError = null;
      } else if (child.status === 1) {
        result = 'miss';
        attemptError = child.stderr ? child.stderr.trim() : 'assertion returned false';
      } else {
        result = 'miss';
        const stderr = child.stderr ? child.stderr.trim() : '';
        attemptError = formatAssertError(stderr || `process exited with code ${child.status}`);
      }
    }
  }

  // An explicit class from the caller beats guessing from free text: a page
  // whose error happens to contain "no longer available" must not be able to
  // masquerade as an environment fault (and vice versa).
  const errclass = result === 'hit'
    ? null
    : (explicitClass === 'env' || explicitClass === 'page'
      ? explicitClass
      : classifyError(attemptError));

  const recorded = recordAttempt(root, {
    url: episode.url,
    intent: episode.intent,
    result,
    error: attemptError,
    errclass,
    threshold,
    captureAfter,
    autoCapture,
    // A failed auto-capture is a store-side problem (e.g. an unsupported host
    // such as file://): it must never turn a successful settlement into a
    // non-zero exit.
    tolerateDraftFailure: true,
  });

  episode.result = result;
  episode.endedAt = now();
  if (!Array.isArray(episode.steps)) episode.steps = [];
  episode.steps.push({
    at: episode.endedAt,
    cmd: 'end',
    ok: result === 'hit',
    error: attemptError ? redactError(attemptError) : null,
  });

  try {
    atomicWrite(stateFile, `${JSON.stringify(episode, null, 2)}\n`);
  } catch {
    // best-effort writeback
  }
  try {
    fs.unlinkSync(stateFile);
  } catch {
    // best-effort delete
  }

  let record = null;
  try {
    const ledger = loadLedger(root);
    record = ledger.keys[recorded.key] || null;
  } catch {
    record = null;
  }

  return {
    session,
    result,
    errclass,
    url: episode.url,
    intent: episode.intent,
    ledgerKey: recorded.key,
    captureRequired: Boolean(recorded.captureRequired),
    draftPath: recorded.draftPath || null,
    draftError: recorded.draftError || null,
    record,
  };
}
