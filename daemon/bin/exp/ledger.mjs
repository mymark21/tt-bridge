// experience/ledger: attempt accounting + capture/update decisions
import {
  findEntryForAttempt,
  mutateEntry,
} from './entry.mjs';
import {
  classifyError,
  entryId,
  makeKey,
  normalizeIntent,
  redactError,
  urlParts,
} from './identity.mjs';
import {
  reindexHost,
} from './index.mjs';
import {
  createDraft,
} from './lifecycle.mjs';
import {
  loadLedger,
  saveLedger,
  withLedgerLock,
} from './store.mjs';
import {
  now,
  parseDuration,
  positiveInt,
} from './util.mjs';

import {
  DEFAULT_CAPTURE_AFTER,
  DEFAULT_MISS_THRESHOLD,
} from './config.mjs';

/**
 * Record a logical attempt (hit/miss) for host|intent and decide whether the
 * caller must capture or update an entry.
 */
export function recordAttempt(root, opts = {}) {
  const {
    url,
    intent,
    result = 'miss',
    error = null,
    id = null,
    threshold = DEFAULT_MISS_THRESHOLD,
    captureAfter = DEFAULT_CAPTURE_AFTER,
    autoCapture = true,
    tolerateDraftFailure = false,
  } = opts;

  if (!url) throw new Error('recordAttempt requires a url');
  if (!intent) throw new Error('recordAttempt requires an intent');
  if (result !== 'hit' && result !== 'miss') {
    throw new Error(`Invalid attempt result "${result}" (expected hit|miss)`);
  }

  const errclass = result === 'hit' ? null : (opts.errclass || classifyError(error));

  const info = urlParts(url);
  const slug = normalizeIntent(intent);
  const host = info.host;
  if (id && !String(id).startsWith(`${host}/`)) {
    throw new Error(`Entry id "${id}" does not belong to host "${host}"`);
  }
  const key = makeKey(host, slug);
  const missThreshold = positiveInt(threshold, DEFAULT_MISS_THRESHOLD, 'threshold');
  const captureThreshold = positiveInt(captureAfter, DEFAULT_CAPTURE_AFTER, 'captureAfter');
  const existing = findEntryForAttempt(root, { host, slug, id });
  if (id && !existing) {
    throw new Error(`Unknown experience entry: ${id}`);
  }

  const snapshot = withLedgerLock(root, () => {
    const ledger = loadLedger(root);
    const record = ledger.keys[key] || {
      host,
      intent: slug,
      attempts: 0,
      misses: 0,
      consecutiveMisses: 0,
      state: null,
      entryId: null,
      errclass: null,
      history: [],
    };
    record.host = host;
    record.intent = slug;
    record.lastUrl = info.url;
    record.lastAt = now();
    // An env failure says nothing about the page, so it must not count toward
    // the capture threshold: three flaky daemon restarts used to auto-capture a
    // phantom playbook with attempts=3 / misses=0.
    if (result === 'hit' || errclass !== 'env') {
      record.attempts = Number(record.attempts || 0) + 1;
    }
    if (result === 'hit') {
      record.consecutiveMisses = 0;
      record.lastResult = 'hit';
      record.lastError = null;
      record.errclass = null;
    } else if (errclass === 'env') {
      record.lastResult = 'miss';
      record.lastError = error ? redactError(error) : null;
      record.errclass = 'env';
      // env error: do not increment misses or consecutiveMisses
    } else {
      record.misses = Number(record.misses || 0) + 1;
      record.consecutiveMisses = Number(record.consecutiveMisses || 0) + 1;
      record.lastResult = 'miss';
      record.lastError = error ? redactError(error) : null;
      record.errclass = 'page';
    }
    if (existing) {
      record.entryId = existing.id;
      record.state = 'captured';
    } else {
      record.state = record.consecutiveMisses >= missThreshold ? 'candidate' : null;
    }
    record.history = [
      ...(Array.isArray(record.history) ? record.history : []),
      {
        at: record.lastAt,
        result,
        url: info.url,
        error: record.lastError,
        errclass: result === 'hit' ? null : (errclass || 'page'),
      },
    ].slice(-50);
    ledger.keys[key] = record;
    saveLedger(root, ledger);
    return {
      record: JSON.parse(JSON.stringify(record)),
      // attempts already excludes env faults, so this counts real page-level
      // outcomes (hits included — a repeated manual flow is exactly what should
      // become a playbook).
      captureRequired: !existing && record.attempts >= captureThreshold,
      updateRequired: Boolean(existing) && record.consecutiveMisses >= missThreshold,
      recommendedKind: Number(record.misses || 0) >= 2 ? 'text' : 'script',
    };
  });

  let updatedEntry = null;
  if (existing) {
    updatedEntry = mutateEntry(root, existing.id, (data) => {
      data.attempts = Number(data.attempts || 0) + 1;
      if (result === 'miss' && errclass !== 'env') data.misses = Number(data.misses || 0) + 1;
      if (result === 'hit') {
        data.confidence = Math.min(1, Math.round((Number(data.confidence || 0.5) + 0.1) * 100) / 100);
        data.last_verified = now();
        if (data.status === 'stale') data.status = 'verified';
      } else if (snapshot.record.consecutiveMisses >= missThreshold && data.status !== 'deprecated') {
        data.status = 'stale';
      }
      data.updated = now();
    });
    reindexHost(root, host);
  }

  let draft = null;
  let draftError = null;
  if (snapshot.captureRequired && autoCapture && !existing) {
    try {
    draft = createDraft(root, {
      url: info.url,
      intent: slug,
      kind: snapshot.recommendedKind,
      description: `Auto-captured experience for ${slug} on ${host}`,
      source: 'auto',
      match: 'prefix',
      attempts: snapshot.record.attempts,
      misses: snapshot.record.misses,
      consecutiveMisses: snapshot.record.consecutiveMisses,
      error: snapshot.record.lastError,
      result,
    });
    } catch (error) {
      // The attempt is already recorded; auto-capture is advisory. Callers that
      // settle a transaction pass tolerateDraftFailure so a store-side failure
      // cannot flip a hit into a non-zero exit.
      if (!tolerateDraftFailure) throw error;
      draftError = error.message;
    }
  }

  return {
    ok: true,
    key,
    host,
    intent: slug,
    result,
    attempts: snapshot.record.attempts,
    misses: snapshot.record.misses,
    consecutiveMisses: snapshot.record.consecutiveMisses,
    state: draft ? 'captured' : snapshot.record.state,
    status: updatedEntry?.status ?? draft?.status ?? null,
    captureRequired: snapshot.captureRequired,
    updateRequired: snapshot.updateRequired,
    recommendedKind: snapshot.recommendedKind,
    suggestedId: updatedEntry?.id || draft?.id || `${host}/${slug}`,
    draftPath: draft?.file || null,
    draftError,
    entryId: updatedEntry?.id || draft?.id || null,
    threshold: missThreshold,
    captureAfter: captureThreshold,
  };
}



export function ledgerList(root) {
  const ledger = loadLedger(root);
  return Object.entries(ledger.keys)
    .map(([key, record]) => ({ key, ...record }))
    .sort((a, b) => String(b.lastAt || '').localeCompare(String(a.lastAt || '')));
}



export function ledgerShow(root, key) {
  const record = loadLedger(root).keys[key];
  if (!record) throw new Error(`Unknown ledger key: ${key}`);
  return { key, ...record };
}



export function pruneLedger(root, opts = {}) {
  const olderThan = opts.olderThan || '90d';
  const cutoff = Date.now() - parseDuration(olderThan);
  let removed = 0;
  const ledger = withLedgerLock(root, () => {
    const loaded = loadLedger(root);
    for (const [key, record] of Object.entries(loaded.keys)) {
      const at = Date.parse(record?.lastAt || record?.capturedAt || '');
      if (!Number.isFinite(at) || at < cutoff) {
        delete loaded.keys[key];
        removed += 1;
      }
    }
    saveLedger(root, loaded);
    return loaded;
  });
  return { ok: true, removed, remaining: Object.keys(ledger.keys).length, olderThan };
}



export function resetLedger(root) {
  withLedgerLock(root, () => saveLedger(root, { version: 1, keys: {} }));
  return { ok: true, remaining: 0 };
}
