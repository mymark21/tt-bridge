// experience/trace: empirical failure rate from the command trace.
//
// Raw material only — a command exiting 0 is not proof the goal was reached,
// and the trace never decides hit/miss (see episodes.mjs).
import fs from 'node:fs';
import path from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 7;
const DAY_FILE_RE = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/;

/**
 * Last N non-empty `arg` values recorded for this host (most recent first).
 * Used by advise() to build a richer similarity query when a single command's
 * arg is too thin (e.g. `document.title`).
 */
export function recentTraceArgs(root, host, n = 3) {
  const traceDir = path.join(path.resolve(root), '_trace');
  const cutoff = Date.now() - WINDOW_DAYS * DAY_MS;
  let files = [];
  try {
    files = fs.readdirSync(traceDir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }
  // Newest file first.
  files.sort().reverse();
  const out = [];
  for (const f of files) {
    if (out.length >= n) break;
    let content;
    try { content = fs.readFileSync(path.join(traceDir, f), 'utf8'); } catch { continue; }
    const lines = content.split('\n').filter(Boolean).reverse();
    for (const line of lines) {
      if (out.length >= n) break;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (!rec || rec.host !== host) continue;
      const stamp = rec.ts || rec.timestamp || rec.at || rec.time;
      if (stamp && new Date(stamp).getTime() < cutoff) continue;
      const arg = rec.arg !== undefined && rec.arg !== null ? String(rec.arg) : '';
      if (arg) out.push(arg);
    }
  }
  return out;
}


/**
 * Failure rate for host+cmd over the last 7 days.
 *
 * `cmd` is the CLI verb (open/click/click/eval/...), which is what advice asks
 * about. Older records only carried the protocol verb in `action`, so fall back
 * to it to keep pre-existing traces useful.
 *
 * Only day-stamped files inside the window are opened: the trace directory has
 * no rotation, so scanning everything on every command would grow unbounded.
 */
export function checkTraceFailureRate(root, host, cmd) {
  const traceDir = path.join(path.resolve(root), '_trace');
  const cutoff = Date.now() - WINDOW_DAYS * DAY_MS;
  let files = [];
  try {
    files = fs.readdirSync(traceDir).filter((f) => {
      if (!f.endsWith('.jsonl')) return false;
      const m = DAY_FILE_RE.exec(f);
      // Unstamped files (legacy or hand-written) are still read: their rows are
      // filtered by the timestamp inside each record.
      if (!m) return true;
      const stamp = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      return stamp + DAY_MS >= cutoff;
    });
  } catch {
    return null;
  }

  let total = 0;
  let fails = 0;
  for (const f of files) {
    let content;
    try {
      content = fs.readFileSync(path.join(traceDir, f), 'utf8');
    } catch {
      continue;
    }
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        // A torn line must not invalidate the rest of the file.
        continue;
      }
      if (!rec || typeof rec !== 'object') continue;
      if (rec.host !== host) continue;
      const verb = rec.cmd || rec.action;
      if (verb !== cmd) continue;
      const stamp = rec.ts || rec.timestamp || rec.at || rec.time;
      if (stamp && new Date(stamp).getTime() < cutoff) continue;
      total += 1;
      if (rec.ok === false || rec.result === 'miss') fails += 1;
    }
  }

  if (total < 2) return null;
  const rate = fails / total;
  return rate >= 0.5 ? { matched: true, rate, total, fails } : null;
}

// Verbs that mean "the agent touched a page". Instance/window/tab bookkeeping
// would inflate the number without any page work, and `show`/`run` are the very
// acknowledgement gestures this measurement reacts to.
export const HARVEST_INTERACTION_CMDS = ['eval', 'click', 'focus', 'input', 'type', 'key', 'open', 'navigate'];

// An acknowledgement is the agent reading or running a stored entry for this
// site. Those are the only gestures that mean "I have this experience in hand".
export const HARVEST_ACK_CMDS = ['show', 'run'];

/**
 * Struggle state for one session on one host, read from the append-only trace.
 *
 * Rows are written strictly after each command finishes, so file order is the
 * ordering signal: no cursor file is needed, and the count survives process
 * exit (every `tt-bridge` invocation is a new process).
 *
 * `sinceAck` resets on every acknowledgement row, which is what makes
 * "struggling again despite having the experience" distinguishable from
 * "struggling with no experience at all".
 */
export function harvestTraceState(root, session, host) {
  const traceDir = path.join(path.resolve(root), '_trace');
  const wantedSession = session === undefined || session === null ? null : String(session);
  const wantedHost = host ? String(host).trim().toLowerCase() : null;
  const state = { host: wantedHost, total: 0, sinceAck: 0, acked: false, ackId: null };
  if (!wantedHost) return state;

  const interactions = new Set(HARVEST_INTERACTION_CMDS);
  const acks = new Set(HARVEST_ACK_CMDS);
  const cutoff = Date.now() - WINDOW_DAYS * DAY_MS;

  let files;
  try {
    // Sorted so a window spanning days is replayed in the order it happened.
    files = fs.readdirSync(traceDir).filter((f) => {
      if (!f.endsWith('.jsonl')) return false;
      const m = DAY_FILE_RE.exec(f);
      if (!m) return true;
      return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + DAY_MS >= cutoff;
    }).sort();
  } catch {
    return state;
  }

  for (const f of files) {
    let content;
    try {
      content = fs.readFileSync(path.join(traceDir, f), 'utf8');
    } catch {
      continue;
    }
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue; // A torn line must not invalidate the rest of the file.
      }
      if (!rec || typeof rec !== 'object') continue;
      if (String(rec.host || '').toLowerCase() !== wantedHost) continue;
      // A null session means "unknown", never a wildcard: folding it into a
      // named session would attribute another agent's work to this one.
      const recSession = rec.session === undefined || rec.session === null ? null : String(rec.session);
      if (recSession !== wantedSession) continue;
      const verb = rec.cmd || rec.action;
      if (acks.has(verb)) {
        state.acked = true;
        state.ackId = rec.arg ? String(rec.arg) : state.ackId;
        state.sinceAck = 0;
        continue;
      }
      if (!interactions.has(verb)) continue;
      state.total += 1;
      state.sinceAck += 1;
    }
  }
  return state;
}
