// experience/advise: decide, at action time, whether one hint is worth printing.
//
// Priority chain (two-stage funnel):
//   0. catalog   — first command on a host: list verified entries (site entry hint)
//   1. similar   — arg-token match against entry codeTokens/descTokens/tags
//   2. entry     — verified entry whose trigger matches the pending action
//   3. pattern   — cross-site pattern
//   4. atom      — empirical failure rate
//   5. silence
// Each stage is a separate function so the ordering stays testable and a broken
// stage cannot take the others down.
import { now } from './util.mjs';
import { countSeen, hasSeen, markSeen, PROCESS_SESSION_ID } from './dedupe.mjs';
import { loadPatterns } from './patterns.mjs';
import { checkTraceFailureRate, recentTraceArgs } from './trace.mjs';
import { loadHostIndex } from './index.mjs';
import { mutateEntry } from './entry.mjs';
import { resolveEntryAssert } from './store.mjs';
import { runLazyAssert } from './exec.mjs';

// ---- similarity helpers -----------------------------------------------------

const STOPWORDS = new Set([
  'document','window','queryselector','queryselectorall','getelementbyid',
  'getattribute','setattribute','return','const','let','var','function','true',
  'false','null','undefined','json','stringify','parse','length','innertext',
  'textcontent','innerhtml','classname','classlist','appendchild','removechild',
  'focus','click','blur','scroll','href','src','value','checked','disabled',
  'style','display','block','none','eval','tt-bridge','bridge','console','log',
  'array','object','string','number','boolean','push','map','filter','find',
  'foreach','join','split','substring','slice','replace','trim','tolowercase',
  'queryselector','getelementsbytagname','addeventlistener','dispatchevent',
]);

function tokenizeArg(argStr) {
  const text = String(argStr || '').toLowerCase();
  const tokens = new Set();
  // identifier-like runs (letters, digits, -, _)
  for (const m of text.matchAll(/[a-z0-9][a-z0-9_-]*/g)) {
    const t = m[0];
    if (t.length < 3) continue;
    if (STOPWORDS.has(t)) continue;
    tokens.add(t);
    // also split on hyphen/underscore to catch sub-tokens (data-slate-leaf -> slate, leaf)
    for (const sub of t.split(/[-_]/)) {
      if (sub.length >= 3 && !STOPWORDS.has(sub)) tokens.add(sub);
    }
  }
  return tokens;
}

function scoreEntryAgainstTokens(entry, queryTokens) {
  if (!queryTokens || queryTokens.size === 0) return 0;
  const pool = new Set([
    ...(entry.codeTokens || []),
    ...(entry.descTokens || []),
    ...(entry.selectors || []),
    ...(entry.tags || []),
  ]);
  let hit = 0;
  for (const t of queryTokens) if (pool.has(t)) hit += 1;
  // normalise by query size; entries with many tokens get tiny IDF-ish bonus via
  // specificity of rare tokens (a token only present in 1 entry is worth more).
  return hit / queryTokens.size;
}

// An un-acked hit keeps nagging, but only every N blind commands. The step
// counter has to live in the cross-process seen cache: each `tt-bridge`
// command is its own process, so a Map would restart at zero on every call and
// the nag would never fire.
const NAG_EVERY_STEPS = 5;

export function matchTrigger(trigger, action, arg) {
  if (typeof trigger !== 'string' || !trigger.trim()) return false;
  if (!action || typeof action !== 'string') return false;
  const colonIdx = trigger.indexOf(':');
  const triggerAction = colonIdx === -1 ? trigger.trim() : trigger.slice(0, colonIdx).trim();
  const triggerArg = colonIdx === -1 ? null : trigger.slice(colonIdx + 1);
  if (triggerAction !== action) return false;
  if (triggerArg === null) return true;
  const argStr = arg === null || arg === undefined ? '' : String(arg);
  return argStr.includes(triggerArg);
}

export function formatAdviceLine(text) {
  let line = String(text || '').trim();
  if (!line.startsWith('[exp] ')) line = `[exp] ${line.replace(/^\\[exp\\]\\s*/, '')}`;
  if (line.length > 200) line = `${truncateCodePoints(line, 199)}…`;
  return line;
}

// Keep the budget but never cut a surrogate pair in half: 199 UTF-16 units may
// land between the two halves of an emoji, and writing a lone surrogate to
// stderr produces a replacement character.
function truncateCodePoints(text, limit) {
  const chars = Array.from(text);
  return chars.length <= limit ? text : chars.slice(0, limit).join('');
}

function advicePrefix(entry) {
  return entry.kind === 'pattern' ? '警告: 命中跨站模式 ' : '建议使用经验 ';
}

function adviceNextStep(entry) {
  if (entry.script) return `tt-bridge experience run ${entry.id}`;
  if (entry.description) return `show ${entry.id} (${entry.description})`;
  if (entry.hasAssert) return `show ${entry.id} + verify with assert.js`;
  return `show ${entry.id}`;
}

// Sentinel: the trigger matched, but this session already saw the hint. This is
// NOT the same as "no match" — the priority chain must stop here.
const SUPPRESSED = Symbol('advice-suppressed');

export function advise(root, opts = {}) {
  try {
    if (!root) return null;
    if (process.env.TT_BRIDGE_EXPERIENCE_SILENT === '1' || opts.quiet) return null;

    const host = opts.host ? String(opts.host).trim().toLowerCase() : '';
    const action = opts.action ? String(opts.action).trim() : '';
    const arg = opts.arg !== undefined ? opts.arg : (opts.args !== undefined ? opts.args : '');
    const argStr = Array.isArray(arg) ? arg.join(' ') : String(arg || '');
    const sessionId = resolveSessionId(opts.session);

    // Failure path: the page failed, so advice keys off the error text only.
    if (opts.failed || opts.ok === false || opts.error) {
      return adviseOnFailure(root, { error: opts.error, sessionId, ignoreSession: opts.ignoreSession });
    }

    if (!host || !action) return null;

    const ctx = { root, host, action, argStr, sessionId, ignoreSession: opts.ignoreSession };
    // Each stage returns advice, NO_MATCH (try the next one) or SUPPRESSED
    // (a trigger matched but this session was already told — the whole call
    // must stay silent, otherwise a deduped entry would fall through and let
    // its cross-site pattern repeat the same hint).
    for (const stage of [adviseCatalog, adviseSimilarEntry, adviseMatchedEntry, adviseMatchedPattern, adviseFailureRate]) {
      const result = stage(ctx);
      if (result === SUPPRESSED) return null;
      if (result) return result;
    }
    return null;
  } catch (e) {
    if (process.env.EXP_DEBUG) console.error('ADVISE THREW:', e && e.stack || e);
    return null;
  }
}

function resolveSessionId(explicit) {
  return (explicit && String(explicit).trim())
    || (process.env.TT_BRIDGE_SESSION && String(process.env.TT_BRIDGE_SESSION).trim())
    || PROCESS_SESSION_ID;
}

/** Failure path: a cross-site pattern may explain the error; never guesses from entries. */
function adviseOnFailure(root, { error: errStr, sessionId, ignoreSession }) {
  const text = String(errStr || '');
  if (!text) return null;
  for (const pat of loadPatterns(root)) {
    if (!patternExplainsError(pat, text)) continue;
    const dedupeKey = `pat-err::${pat.id}::${text.slice(0, 40)}`;
    if (!ignoreSession && hasSeen(sessionId, dedupeKey)) return null;
    markSeen(sessionId, dedupeKey);
    return {
      line: formatAdviceLine(`警告: 命令失败命中跨站模式 ${pat.id}: ${pat.description || pat.slug}`),
      entryId: pat.id,
      kind: 'pattern',
      reason: 'pattern-error-match',
      lastVerified: pat.lastVerified,
    };
  }
  return null;
}

function patternExplainsError(pat, errStr) {
  const triggers = Array.isArray(pat.triggers) ? pat.triggers : [];
  for (const trig of triggers) {
    if (typeof trig === 'string' && trig.startsWith('error:') && errStr.includes(trig.slice(6))) return true;
  }
  return Boolean(pat.description && errStr.includes(pat.description));
}

/** 0. Catalog: first interaction with a host — list verified entries once. */
function adviseCatalog({ root, host, sessionId, ignoreSession }) {
  // `ignoreSession` asks for the best advice right now, which is never a
  // one-time onboarding listing: skipping here lets the targeted stages answer.
  if (ignoreSession) return null;
  const catalogKey = `catalog::${host}`;
  if (hasSeen(sessionId, catalogKey)) return null;
  const hostIndex = loadHostIndex(root, host);
  if (!Array.isArray(hostIndex.entries) || hostIndex.entries.length === 0) return null;
  const verified = hostIndex.entries.filter((e) => e.status === 'verified');
  if (verified.length === 0) return null;
  markSeen(sessionId, catalogKey);
  const top = verified.slice(0, 3);
  const listed = top.map((e) => `${e.id} (${e.description || e.slug})`).join('; ');
  const line = `${host} 有 ${verified.length} 条验证经验: ${listed} → 动手前先看: tt-bridge experience show <id>`;
  return {
    line: formatAdviceLine(line),
    entryId: top[0].id,
    kind: 'catalog',
    reason: 'site-catalog',
    // Same payload shape as every other stage, so a caller that surfaces
    // `lastVerified` does not lose it just because the answer was a listing.
    lastVerified: top[0].lastVerified || null,
  };
}

/**
 * 1. Similar entry: the command arg carries DOM/intent tokens; match them
 *    against the entry's codeTokens/descTokens/tags/selectors. Top hit above
 *    threshold gets an actionable hint. Re-nags every N steps while un-acked.
 */
function adviseSimilarEntry({ root, host, action, argStr, sessionId, ignoreSession }) {
  const hostIndex = loadHostIndex(root, host);
  if (!Array.isArray(hostIndex.entries)) return null;
  const verified = hostIndex.entries.filter((e) => e.status === 'verified');
  if (verified.length === 0) return null;

  // Build query tokens from current arg + last 3 trace args for the same host.
  let recentArgs = [];
  try { recentArgs = recentTraceArgs(root, host, 3); } catch {}
  const queryText = [argStr, ...recentArgs].join(' ');
  const queryTokens = tokenizeArg(queryText);
  if (queryTokens.size === 0) return null;

  let best = null;
  let bestScore = 0;
  for (const entry of verified) {
    const score = scoreEntryAgainstTokens(entry, queryTokens);
    if (score > bestScore) { bestScore = score; best = entry; }
  }
  // Minimum signal: at least 2 distinct tokens matched, or 1 token covering ≥30% of query.
  if (!best || bestScore < 0.15) return null;

  const entryId = best.id;
  const acked = !ignoreSession && hasSeen(sessionId, `ack::${entryId}`);
  if (acked) return null;

  const dedupeKey = `similar::${entryId}`;
  const alreadyShown = !ignoreSession && hasSeen(sessionId, dedupeKey);

  if (!alreadyShown) {
    markSeen(sessionId, dedupeKey);
    const line = `命中经验 ${entryId} (${best.description || best.slug}) → 停止盲试, 立即运行: tt-bridge experience show ${entryId}`;
    return {
      line: formatAdviceLine(line),
      entryId,
      kind: 'similar',
      reason: `token-match-${bestScore.toFixed(2)}`,
    };
  }

  // Shown but not acked: count this entry's blind steps and speak on every
  // Nth one. The seen cache is append-only, so `% NAG_EVERY_STEPS` gives the
  // rhythm without needing a reset.
  markSeen(sessionId, `nag::${entryId}`);
  const steps = countSeen(sessionId, `nag::${entryId}`);
  if (steps % NAG_EVERY_STEPS !== 0) return null;
  const line = `仍未查阅经验 ${entryId}; 盲试前请运行: tt-bridge experience show ${entryId}`;
  return {
    line: formatAdviceLine(line),
    entryId,
    kind: 'similar',
    reason: `unacked-nag-${steps}`,
  };
}

/** 2. A verified entry for this host whose trigger matches the pending action. */
function adviseMatchedEntry({ root, host, action, argStr, sessionId, ignoreSession }) {
  const hostIndex = loadHostIndex(root, host);
  if (!Array.isArray(hostIndex.entries)) return null;
  for (const entry of hostIndex.entries) {
    if (!entry || entry.status !== 'verified') continue;
    const matchedTrigger = firstMatchingTrigger(entry.triggers, action, argStr);
    if (!matchedTrigger) continue;
    const dedupeKey = `${host}::${matchedTrigger}`;
    if (!ignoreSession && hasSeen(sessionId, dedupeKey)) return SUPPRESSED;
    markSeen(sessionId, dedupeKey);
    return verifyThenAdvise(root, entry);
  }
  return null;
}

function firstMatchingTrigger(triggers, action, argStr) {
  for (const trig of Array.isArray(triggers) ? triggers : []) {
    if (matchTrigger(trig, action, argStr)) return trig;
  }
  return null;
}

/**
 * Lazy verification: an entry older than 30 days is re-proven by running its
 * assert.js. Only a failed assertion demotes — age alone never does.
 */
function verifyThenAdvise(root, entry) {
  const age = entryAgeDays(entry.lastVerified);
  const assertFile = resolveEntryAssert(root, entry.id);
  const hasAssert = Boolean(assertFile);

  if (age.olderThan30Days && hasAssert) {
    const outcome = runLazyAssert(assertFile);
    if (outcome === 'ok') {
      try {
        mutateEntry(root, entry.id, (data) => { data.last_verified = now(); data.status = 'verified'; });
      } catch {}
      return entryAdvice(entry, {
        reason: 'trigger-match-verified',
        lastVerified: now(),
        line: `${advicePrefix(entry)}${entry.id}: ${adviceNextStep(entry)}`,
      });
    }
    if (outcome === 'timeout') {
      return entryAdvice(entry, {
        reason: 'assertion-timeout',
        lastVerified: entry.lastVerified,
        line: `经验 ${entry.id} 匹配但断言超时 (未验证)`,
      });
    }
    try {
      mutateEntry(root, entry.id, (data) => { data.status = 'stale'; });
    } catch {}
    return entryAdvice(entry, {
      reason: 'assertion-failed-stale',
      lastVerified: entry.lastVerified,
      line: `条目 ${entry.id} 验证已失效(stale)，暂无有效经验 (未验证)`,
    });
  }

  let line = `${advicePrefix(entry)}${entry.id}: ${adviceNextStep(entry)}`;
  if (age.olderThan30Days && !hasAssert) line += ` (未验证 ${age.daysAgo} 天)`;
  return entryAdvice(entry, { reason: 'trigger-match', lastVerified: entry.lastVerified, line });
}

function entryAdvice(entry, { reason, lastVerified, line }) {
  return { line: formatAdviceLine(line), entryId: entry.id, kind: 'entry', reason, lastVerified };
}

function entryAgeDays(lastVerified) {
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  if (!lastVerified) return { olderThan30Days: true, daysAgo: 31 };
  const ts = new Date(lastVerified).getTime();
  if (!Number.isFinite(ts)) return { olderThan30Days: true, daysAgo: 31 };
  const diff = Date.now() - ts;
  return { olderThan30Days: diff > THIRTY_DAYS_MS, daysAgo: Math.floor(diff / (24 * 60 * 60 * 1000)) };
}

/** 2. A cross-site pattern whose trigger matches. */
function adviseMatchedPattern({ root, action, argStr, sessionId, ignoreSession }) {
  for (const pat of loadPatterns(root)) {
    const matchedTrigger = firstMatchingTrigger(pat.triggers, action, argStr);
    if (!matchedTrigger) continue;
    const dedupeKey = `pattern::${pat.id}::${matchedTrigger}`;
    if (!ignoreSession && hasSeen(sessionId, dedupeKey)) return SUPPRESSED;
    markSeen(sessionId, dedupeKey);
    return {
      line: formatAdviceLine(`警告: 命中跨站模式 ${pat.id}: ${pat.description || pat.slug}`),
      entryId: pat.id,
      kind: 'pattern',
      reason: 'pattern-trigger-match',
      lastVerified: pat.lastVerified,
    };
  }
  return null;
}

/** 3. Empirical failure rate from the command trace. */
function adviseFailureRate({ root, host, action, sessionId, ignoreSession }) {
  const stats = checkTraceFailureRate(root, host, action);
  if (!stats || !stats.matched) return null;
  const dedupeKey = `atom::${host}::${action}`;
  if (!ignoreSession && hasSeen(sessionId, dedupeKey)) return SUPPRESSED;
  markSeen(sessionId, dedupeKey);
  const pct = Math.round(stats.rate * 100);
  return {
    line: formatAdviceLine(`提示: 站点 ${host} 动作 ${action} 近7天失败率 ${pct}% (样本 ${stats.total})`),
    entryId: null,
    kind: 'atom',
    reason: `failure-rate-${pct}%`,
  };
}
