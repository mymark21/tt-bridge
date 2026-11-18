// experience/entries: the playbook record lifecycle: read/write/draft/mutate/finalize
import fs from 'node:fs';
import path from 'node:path';
import {
  FRONTMATTER_FIELDS,
  HOST_RE,
  KINDS,
  MATCH_TYPES,
  SCHEMA_VERSION,
  STATUSES,
} from './config.mjs';
import {
  runEntry,
} from './exec.mjs';
import {
  parseFrontmatter,
  serializeFrontmatter,
} from './frontmatter.mjs';
import {
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
  assertInsideRoot,
  atomicWrite,
  entryFile,
  loadLedger,
  saveLedger,
  slugFromId,
  withLedgerLock,
} from './store.mjs';
import {
  normalizeTags,
  now,
  tail,
} from './util.mjs';

// ── entries ──────────────────────────────────────────────────────────

// An entry's identity is its location: <host>/<slug>. Frontmatter may agree,
// but it can never redirect the id somewhere else.
function deriveEntryId(dir, data, slug) {
  const parent = path.basename(path.dirname(dir));
  const host = String(data.host || parent || '').trim().toLowerCase();
  const claimed = data.id ? String(data.id) : '';
  const located = `${host}/${slug}`;
  if (claimed && claimed !== located) {
    // Ignore a mismatched id; a mismatch means the file was copied or edited by
    // hand and its location is still the truth.
    return located;
  }
  return located;
}

export function frontmatterFromEntry(entry) {
  const data = {};
  for (const key of FRONTMATTER_FIELDS) {
    if (entry[key] !== undefined) data[key] = entry[key];
  }
  return data;
}

export function readEntry(file) {
  const absolute = path.resolve(file);
  const text = fs.readFileSync(absolute, 'utf8');
  const { data, body, hasFrontmatter } = parseFrontmatter(text);
  if (!hasFrontmatter) throw new Error(`Missing frontmatter: ${absolute}`);
  const dir = path.dirname(absolute);
  const slug = data.slug ? String(data.slug) : path.basename(dir);
  for (const field of ['tags', 'preconditions', 'selectors', 'verification', 'triggers']) {
    if (typeof data[field] === 'string') data[field] = data[field] ? [data[field]] : [];
    else if (!Array.isArray(data[field])) data[field] = [];
  }
  const script = typeof data.script === 'string' && data.script.trim() ? data.script.trim() : null;
  return {
    ...data,
    // The id must describe the file that actually holds this entry: a shared
    // playbook with a hostile `id:` field would otherwise name paths outside
    // the store and poison the index that advise() reads.
    id: deriveEntryId(dir, data, slug),
    host: data.host || '',
    slug,
    script,
    scriptPath: script ? path.join(dir, script) : null,
    body,
    file: absolute,
    dir,
  };
}



/**
 * Find/list must stay cheap for the agent's context: bodies are only returned
 * by `show`, never by discovery commands.
 */

export function summarizeEntry(entry) {
  const { body, ...summary } = entry;
  return summary;
}

export function nextAvailableId(root, host, slug) {
  for (let index = 1; index <= 100; index += 1) {
    const candidate = index === 1 ? `${host}/${slug}` : `${host}/${slug}-${index}`;
    const file = path.join(path.resolve(root), host, slugFromId(candidate), 'entry.md');
    if (!fs.existsSync(file)) return candidate;
  }
  throw new Error(`Too many entries for ${host}/${slug}`);
}

export function entryExists(root, id) {
  try {
    return fs.existsSync(entryFile(root, id));
  } catch {
    return false;
  }
}

export function writeEntry(dir, data, body) {
  const text = serializeFrontmatter(data) + String(body ?? '').replace(/\r\n/g, '\n');
  atomicWrite(path.join(dir, 'entry.md'), text.endsWith('\n') ? text : `${text}\n`);
}

export function mutateEntry(root, id, mutator) {
  const entry = readEntry(entryFile(root, id));
  const data = frontmatterFromEntry(entry);
  mutator(data);
  data.updated = data.updated || now();
  writeEntry(entry.dir, data, entry.body);
  try { reindexHost(root, entry.host); } catch {}
  return readEntry(entry.file);
}

export function findEntryForAttempt(root, { host, slug, id }) {
  if (id) {
    try { return readEntry(entryFile(root, id)); } catch { /* fall through */ }
  }
  try {
    const record = loadLedger(root).keys[makeKey(host, slug)];
    if (record?.entryId) {
      try { return readEntry(entryFile(root, record.entryId)); } catch { /* fall through */ }
    }
  } catch {
    // Ignore an unreadable ledger here; recordAttempt will surface the error.
  }
  try { return readEntry(entryFile(root, `${host}/${slug}`)); } catch { return null; }
}



// ── finalize / update / deprecate ────────────────────────────────────
