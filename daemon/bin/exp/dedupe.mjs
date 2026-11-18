// experience/dedupe: cross-process suppression of repeated advice.
//
// Each tt-bridge command is a fresh process, so an in-memory Set would re-show
// the same hint forever. The disk side is an append-only JSONL cache (not user
// data): losing a line costs one repeated hint, so it skips fsync for the hot path.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SEEN_TTL_MS,
  SESSION_BUCKET_HOURS,
} from './config.mjs';

export const PROCESS_SESSION_ID = `auto-${Math.floor(Date.now() / (SESSION_BUCKET_HOURS * 3600 * 1000))}`;


const sessionSeenTriggers = new Map();



function sessionFilePath(sessionId) {
  const safe = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(os.tmpdir(), `tt-bridge-seen-${safe}.json`);
}



function getSeenSet(sessionId) {
  if (!sessionSeenTriggers.has(sessionId)) {
    sessionSeenTriggers.set(sessionId, new Set());
  }
  return sessionSeenTriggers.get(sessionId);
}



function readSeenFile(sessionId) {
  try {
    const file = sessionFilePath(sessionId);
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (!raw) return [];
    const cutoff = Date.now() - SEEN_TTL_MS;
    // Legacy format was one JSON array; new format is JSONL.
    const items = raw.startsWith('[')
      ? JSON.parse(raw)
      : raw.split('\n').map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);
    if (!Array.isArray(items)) return [];
    return items.filter((item) => {
      if (typeof item === 'string') return true; // legacy entries, kept as-is
      return item && typeof item.key === 'string' && Number(item.at) > cutoff;
    });
  } catch {
    return [];
  }
}



export function hasSeen(sessionId, key) {
  if (getSeenSet(sessionId).has(key)) return true;
  const found = readSeenFile(sessionId).some((item) => (typeof item === 'string' ? item : item.key) === key);
  if (found) getSeenSet(sessionId).add(key);
  return found;
}


/**
 * How many times a key was marked for this session. The seen cache is
 * append-only, so a repeated key is a counter — which is what the un-acked
 * nag needs. In-memory Sets cannot serve that role: every command is a fresh
 * process, and the TTL filter ages the count back down on its own.
 */
export function countSeen(sessionId, key) {
  let count = 0;
  for (const item of readSeenFile(sessionId)) {
    if ((typeof item === 'string' ? item : item.key) === key) count += 1;
  }
  return count;
}



export function markSeen(sessionId, key) {
  getSeenSet(sessionId).add(key);
  try {
    fs.appendFileSync(sessionFilePath(sessionId), `${JSON.stringify({ key, at: Date.now() })}\n`, 'utf8');
  } catch {}
}



export function resetAdviceSession(sessionId) {
  if (sessionId) {
    sessionSeenTriggers.delete(sessionId);
    try { fs.unlinkSync(sessionFilePath(sessionId)); } catch {}
    return;
  }
  // Clearing only the in-memory map would leave the on-disk dedupe cache hot,
  // so the next call (in this process or the next one) would still be silent.
  for (const id of [...sessionSeenTriggers.keys()]) {
    try { fs.unlinkSync(sessionFilePath(id)); } catch {}
  }
  sessionSeenTriggers.clear();
  try { fs.unlinkSync(sessionFilePath(PROCESS_SESSION_ID)); } catch {}
}
