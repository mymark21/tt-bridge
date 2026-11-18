// experience/util: pure generic helpers with no domain meaning
import path from 'node:path';

// ── small helpers ────────────────────────────────────────────────────

export function now() {
  return new Date().toISOString();
}



export function tail(text, limit = 2000) {
  const str = String(text || '');
  return str.length <= limit ? str : str.slice(str.length - limit);
}



export function positiveInt(value, fallback, label) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) throw new Error(`${label} must be a positive integer`);
  return Math.floor(n);
}



export function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}



export function normalizeTags(tags) {
  const list = Array.isArray(tags)
    ? tags
    : String(tags || '').split(',');
  const seen = new Set();
  const out = [];
  for (const tag of list) {
    const value = String(tag).trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= 50) break;
  }
  return out;
}



export function isSafeRelativeFilename(name) {
  return typeof name === 'string'
    && name.length > 0
    && name !== '.'
    && name !== '..'
    && !name.includes('/')
    && !name.includes('\\')
    && !path.isAbsolute(name);
}



export function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}



export function parseDuration(value) {
  const match = /^(\d+)\s*(ms|s|m|h|d|w)$/i.exec(String(value || '').trim());
  if (!match) throw new Error(`Invalid duration "${value}" (expected e.g. 90d, 12h, 30m)`);
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const factor = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[unit];
  return amount * factor;
}
