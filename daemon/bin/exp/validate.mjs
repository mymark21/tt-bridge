// experience/validate: entry integrity checks
import fs from 'node:fs';
import path from 'node:path';

import {
  parseFrontmatter,
} from './frontmatter.mjs';
import {
  normalizeUrl,
} from './identity.mjs';
import {
  walkEntryFiles,
} from './index.mjs';
import {
  entryFile,
} from './store.mjs';
import {
  readEntry,
} from './entry.mjs';
import {
  escapeRegExp,
  isSafeRelativeFilename,
} from './util.mjs';

import {
  KINDS,
  MATCH_TYPES,
  SCHEMA_VERSION,
  STATUSES,
} from './config.mjs';

// ── validation / index ───────────────────────────────────────────────

export function validateEntry(root, id) {
  const errors = [];
  const warnings = [];
  let entry;
  try {
    entry = readEntry(entryFile(root, id));
  } catch (error) {
    return { id, ok: false, errors: [error.message], warnings };
  }

  const required = [
    'schema', 'id', 'host', 'url', 'match', 'kind', 'description', 'created',
    'updated', 'last_verified', 'status', 'confidence', 'tags', 'preconditions',
    'selectors', 'verification', 'attempts', 'misses', 'source',
  ];
  let rawFrontmatter = {};
  try {
    rawFrontmatter = parseFrontmatter(fs.readFileSync(entry.file, 'utf8')).data;
  } catch {
    // parseFrontmatter errors are already surfaced by readEntry.
  }
  for (const field of required) {
    if (!(field in rawFrontmatter)) errors.push(`missing required field "${field}"`);
  }
  if (entry.schema !== SCHEMA_VERSION) errors.push(`schema must be ${SCHEMA_VERSION} (got ${JSON.stringify(entry.schema)})`);
  if (entry.id !== id) errors.push(`frontmatter id "${entry.id}" does not match requested id "${id}"`);
  if (!MATCH_TYPES.includes(entry.match)) errors.push(`invalid match "${entry.match}"`);
  if (!KINDS.includes(entry.kind)) errors.push(`invalid kind "${entry.kind}"`);
  if (!STATUSES.includes(entry.status)) errors.push(`invalid status "${entry.status}"`);
  if (entry.source !== 'manual' && entry.source !== 'auto') errors.push('source must be "manual" or "auto"');
  if (entry.status === 'verified' && !String(entry.last_verified || '').trim()) {
    errors.push('status "verified" requires a non-empty last_verified');
  }

  const confidence = Number(entry.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    errors.push('confidence must be between 0 and 1');
  }
  for (const field of ['attempts', 'misses']) {
    const value = Number(entry[field]);
    if (!Number.isInteger(value) || value < 0) errors.push(`${field} must be a non-negative integer`);
  }
  for (const field of ['tags', 'preconditions', 'selectors', 'verification', 'triggers']) {
    if (!Array.isArray(entry[field])) errors.push(`"${field}" must be an array`);
  }

  try {
    const parsed = new URL(entry.url);
    if (parsed.host.toLowerCase() !== String(entry.host).toLowerCase()) {
      errors.push(`host "${entry.host}" does not match url host "${parsed.host}"`);
    }
    const normalized = normalizeUrl(entry.url);
    if (normalized !== entry.url) warnings.push(`url is not normalized (suggest "${normalized}")`);
  } catch {
    errors.push(`invalid url "${entry.url}"`);
  }

  const expected = path.resolve(root, ...String(id).split('/'), 'entry.md');
  if (path.resolve(entry.file) !== expected) {
    errors.push('entry file is not at the canonical path for its id');
  }

  if (entry.script) {
    if (!isSafeRelativeFilename(entry.script)) {
      errors.push(`script path "${entry.script}" must be a simple relative filename`);
    } else if (!fs.existsSync(path.join(entry.dir, entry.script))) {
      errors.push(`script file not found: ${entry.script}`);
    }
    if (entry.kind === 'text') errors.push('kind "text" must not declare a script');
  } else if (entry.kind === 'script' || entry.kind === 'hybrid') {
    const message = `kind "${entry.kind}" requires a script`;
    if (entry.status === 'draft') warnings.push(`${message} (draft may add one before finalize)`);
    else errors.push(message);
  }

  for (const section of ['## 目标', '## 步骤', '## 验证']) {
    if (!new RegExp(`^${escapeRegExp(section)}\\s*$`, 'm').test(entry.body)) {
      warnings.push(`missing body section "${section}"`);
    }
  }

  return { id, ok: errors.length === 0, errors, warnings };
}



export function validateAll(root) {
  const ids = walkEntryFiles(root).map(({ id }) => id);
  const results = ids.map((id) => validateEntry(root, id));
  const errors = results
    .filter((result) => !result.ok)
    .map((result) => ({ id: result.id, errors: result.errors }));
  const warnings = results
    .filter((result) => result.warnings.length > 0)
    .map((result) => ({ id: result.id, warnings: result.warnings }));
  return {
    ok: errors.length === 0,
    checked: results.length,
    errors,
    warnings,
  };
}
