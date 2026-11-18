// experience/index: derived per-site discovery buckets + find/list/score
import fs from 'node:fs';
import path from 'node:path';

import {
  normalizeIntent,
  normalizeUrl,
  urlParts,
} from './identity.mjs';
import {
  atomicWrite,
  hostIndexPath,
} from './store.mjs';
import {
  readEntry,
} from './entry.mjs';
import {
  escapeRegExp,
  now,
} from './util.mjs';

import {
  MATCH_BASE,
  STATUS_SCORE,
} from './config.mjs';

export function walkEntryFiles(root) {
  const base = path.resolve(root);
  let hosts;
  try {
    hosts = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const hostDir of hosts) {
    if (!hostDir.isDirectory() || hostDir.name.startsWith('_') || hostDir.name.startsWith('.')) continue;
    const hostPath = path.join(base, hostDir.name);
    let slugs;
    try {
      slugs = fs.readdirSync(hostPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const slugDir of slugs) {
      if (!slugDir.isDirectory() || slugDir.name.startsWith('_') || slugDir.name.startsWith('.')) continue;
      const file = path.join(hostPath, slugDir.name, 'entry.md');
      if (fs.existsSync(file)) {
        files.push({ id: `${hostDir.name}/${slugDir.name}`, file });
      }
    }
  }
  return files;
}



function stringList(value) {
  return Array.isArray(value)
    ? value.map((item) => (item === null || item === undefined ? '' : String(item))).filter(Boolean)
    : [];
}

export function loadHostIndex(root, host) {
  const safeHost = String(host || '').trim().toLowerCase();
  const empty = { schema: 1, host: safeHost, builtAt: null, entries: [] };
  if (!safeHost) return empty;
  // Index buckets are named after the host an entry was captured on, so a page
  // reached as www.example.com must still find the example.com bucket.
  const bare = safeHost.replace(/^www\./, '');
  for (const candidate of bare === safeHost ? [safeHost] : [safeHost, bare]) {
    const index = readHostIndexFile(root, candidate);
    if (index) return index;
  }
  return empty;
}

function readHostIndexFile(root, host) {
  try {
    const file = hostIndexPath(root, host);
    if (!fs.existsSync(file)) return null;
    const content = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (!Array.isArray(parsed.entries)) return null;
    return {
      schema: parsed.schema || 1,
      host: parsed.host || host,
      builtAt: parsed.builtAt || null,
      entries: parsed.entries
        .filter((e) => e && typeof e === 'object')
        .map((e) => ({
          id: String(e.id || ''),
          slug: String(e.slug || ''),
          kind: String(e.kind || ''),
          status: String(e.status || ''),
          confidence: Number(e.confidence) || 0,
          lastVerified: e.lastVerified ? String(e.lastVerified) : null,
          triggers: stringList(e.triggers),
          description: e.description ? String(e.description) : '',
          script: e.script ? String(e.script) : null,
          hasAssert: Boolean(e.hasAssert),
          tags: stringList(e.tags),
          selectors: stringList(e.selectors),
          codeTokens: stringList(e.codeTokens),
          descTokens: stringList(e.descTokens),
        })),
    };
  } catch {
    return null;
  }
}



// Text features for recall: the identifiers an entry's snippets touch and the
// words its one-line description carries. Both go into the host index so a
// matcher can rank entries against a command argument without re-reading every
// entry body.
const CODE_LANGS = new Set(['bash', 'javascript']);
const CODE_BLOCK_RE = /```[ \t]*([^\n`]*)\n([\s\S]*?)```/g;
const CODE_TOKEN_RE = /[a-z0-9][a-z0-9_-]*/g;
const EN_WORD_RE = /[a-z]+/g;
const CJK_RUN_RE = /[\u4e00-\u9fff]+/g;
const CODE_STOPWORDS = new Set([
  'document', 'window', 'queryselector', 'queryselectorall', 'getelementbyid',
  'getattribute', 'setattribute', 'return', 'const', 'let', 'var', 'function',
  'true', 'false', 'null', 'undefined', 'json', 'stringify', 'parse', 'length',
  'innertext', 'textcontent', 'innerhtml', 'classname', 'classlist', 'appendchild',
  'removechild', 'focus', 'click', 'blur', 'scroll', 'href', 'src', 'value',
  'checked', 'disabled', 'style', 'display', 'block', 'none',
]);

function pushUnique(list, seen, token) {
  if (!token || seen.has(token)) return;
  seen.add(token);
  list.push(token);
}

export function extractCodeTokens(body) {
  const tokens = [];
  const seen = new Set();
  for (const block of String(body || '').matchAll(CODE_BLOCK_RE)) {
    const lang = block[1].trim().toLowerCase().split(/\s+/)[0];
    if (!CODE_LANGS.has(lang)) continue;
    for (const token of block[2].toLowerCase().match(CODE_TOKEN_RE) || []) {
      if (token.length < 3 || CODE_STOPWORDS.has(token)) continue;
      pushUnique(tokens, seen, token);
    }
  }
  return tokens;
}

export function extractDescriptionTokens(description) {
  const tokens = [];
  const seen = new Set();
  const text = String(description || '').toLowerCase();
  for (const word of text.match(EN_WORD_RE) || []) pushUnique(tokens, seen, word);
  for (const run of text.match(CJK_RUN_RE) || []) {
    for (let i = 0; i + 1 < run.length; i += 1) pushUnique(tokens, seen, run.slice(i, i + 2));
  }
  return tokens;
}

export function reindexHost(root, host) {
  const safeHost = String(host || '').trim().toLowerCase();
  if (!safeHost) return null;
  const hostDir = path.join(path.resolve(root), safeHost);
  let slugs = [];
  try {
    slugs = fs.readdirSync(hostDir, { withFileTypes: true });
  } catch {
    slugs = [];
  }
  const entries = [];
  for (const slugDir of slugs) {
    if (!slugDir.isDirectory() || slugDir.name.startsWith('_') || slugDir.name.startsWith('.')) continue;
    const file = path.join(hostDir, slugDir.name, 'entry.md');
    if (fs.existsSync(file)) {
      try {
        const entry = readEntry(file);
        entries.push({
          id: entry.id,
          slug: entry.slug,
          kind: entry.kind,
          status: entry.status,
          confidence: entry.confidence,
          lastVerified: entry.last_verified || null,
          triggers: Array.isArray(entry.triggers) ? entry.triggers : [],
          tags: Array.isArray(entry.tags) ? entry.tags : [],
          selectors: Array.isArray(entry.selectors) ? entry.selectors : [],
          description: entry.description || '',
          script: entry.script || null,
          hasAssert: fs.existsSync(path.join(hostDir, slugDir.name, 'assert.js')),
          codeTokens: extractCodeTokens(entry.body),
          descTokens: extractDescriptionTokens(entry.description),
        });
      } catch {
        // ignore malformed entry
      }
    }
  }
  const indexData = {
    schema: 1,
    host: safeHost,
    builtAt: now(),
    entries,
  };
  const target = hostIndexPath(root, safeHost);
  atomicWrite(target, `${JSON.stringify(indexData, null, 2)}\n`);
  return indexData;
}



export function listEntries(root, filters = {}) {
  const entries = [];
  for (const { file } of walkEntryFiles(root)) {
    let entry;
    try {
      entry = readEntry(file);
    } catch {
      continue;
    }
    if (filters.host && entry.host !== filters.host) continue;
    if (filters.kind && entry.kind !== filters.kind) continue;
    if (filters.status && entry.status !== filters.status) continue;
    entries.push(entry);
  }
  entries.sort((a, b) => a.id.localeCompare(b.id));
  return entries;
}



function globToRegExp(pattern) {
  let source = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        source += '.*';
        i += 1;
      } else {
        source += '[^/]*';
      }
      continue;
    }
    source += escapeRegExp(char);
  }
  return new RegExp(`${source}$`);
}



function matchEntry(entry, normalizedUrl) {
  const kind = entry.match || 'prefix';
  let target;
  try {
    target = normalizeUrl(entry.url);
  } catch {
    return null;
  }
  if (kind === 'exact') return target === normalizedUrl ? 'exact' : null;
  if (kind === 'glob') return globToRegExp(target).test(normalizedUrl) ? 'glob' : null;
  if (normalizedUrl === target) return 'prefix';
  const base = target.endsWith('/') ? target : `${target}/`;
  return normalizedUrl.startsWith(base) ? 'prefix' : null;
}



function globLiteralLength(value) {
  return String(value || '').replace(/\*/g, '').length;
}



function intentOverlap(entry, intent) {
  if (!intent) return 0;
  const wanted = new Set(intent.split('-').filter(Boolean));
  const tags = Array.isArray(entry.tags) ? entry.tags : [String(entry.tags || '')];
  const haystack = new Set(
    `${entry.id} ${entry.description || ''} ${tags.join(' ')}`
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
  let overlap = 0;
  for (const token of wanted) if (haystack.has(token)) overlap += 1;
  return overlap;
}



function scoreEntry(entry, info, intent) {
  const matchType = matchEntry(entry, info.url);
  if (!matchType) return { matchType: null, score: -1 };
  const base = MATCH_BASE[matchType] || 0;
  const specificity = matchType === 'glob'
    ? globLiteralLength(entry.url)
    : String(entry.url || '').length;
  const status = STATUS_SCORE[entry.status] ?? 0;
  const confidence = Number(entry.confidence) || 0;
  const overlap = intentOverlap(entry, intent);
  return {
    matchType,
    score: base + specificity + status + Math.round(confidence * 100) + overlap * 15,
  };
}



/**
 * Find entries applicable to a URL, ranked by match specificity, status,
 * confidence and intent-token overlap.
 */
export function findEntries(root, rawUrl, opts = {}) {
  const info = urlParts(rawUrl);
  const intent = opts.intent ? normalizeIntent(opts.intent) : null;
  let candidates = listEntries(root, { host: info.host });
  if (intent) {
    const collision = new RegExp(`^${escapeRegExp(intent)}-\\d+$`);
    candidates = candidates.filter((entry) => entry.slug === intent || collision.test(entry.slug));
  }
  if (!opts.all) {
    candidates = candidates.filter((entry) => entry.status !== 'deprecated' && matchEntry(entry, info.url));
  }
  return candidates
    .map((entry) => {
      const { matchType, score } = scoreEntry(entry, info, intent);
      return { ...entry, matchType, score };
    })
    .sort((a, b) => b.score - a.score
      || String(b.updated || '').localeCompare(String(a.updated || ''))
      || a.id.localeCompare(b.id));
}



export function rebuildIndex(root) {
  const base = path.resolve(root);
  let hostDirs = [];
  try {
    hostDirs = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    hostDirs = [];
  }
  for (const d of hostDirs) {
    if (d.isDirectory() && !d.name.startsWith('_') && !d.name.startsWith('.')) {
      try { reindexHost(root, d.name); } catch {}
    }
  }

  const entries = listEntries(root);
  const index = {
    version: 1,
    generated: now(),
    count: entries.length,
    entries: entries.map((entry) => ({
      id: entry.id,
      host: entry.host,
      slug: entry.slug,
      url: entry.url,
      match: entry.match,
      kind: entry.kind,
      status: entry.status,
      confidence: entry.confidence,
      description: entry.description,
      tags: entry.tags,
      triggers: Array.isArray(entry.triggers) ? entry.triggers : [],
      updated: entry.updated,
      script: entry.script,
      path: path.relative(path.resolve(root), entry.file),
    })),
  };
  atomicWrite(path.join(root, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
  return index;
}
