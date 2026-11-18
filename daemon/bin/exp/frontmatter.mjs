// experience/frontmatter: flat YAML subset codec
import {
  FRONTMATTER_FIELDS,
} from './config.mjs';

// ── frontmatter (flat YAML subset) ───────────────────────────────────

function parseScalar(raw) {
  const value = String(raw).trim();
  if (value === '') return '';
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (/^(?:true|false)$/i.test(value)) return value.toLowerCase() === 'true';
  if (/^(?:null|~)$/i.test(value)) return null;
  if (/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) return Number(value);
  return value;
}



function splitInlineArray(value) {
  const inner = value.slice(1, -1);
  const parts = [];
  let current = '';
  let quote = null;
  let escaped = false;
  for (const char of inner) {
    if (quote) {
      current += char;
      if (quote === '"' && char === '\\' && !escaped) {
        escaped = true;
        continue;
      }
      if (char === quote && !escaped) quote = null;
      escaped = false;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ',') {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (quote) throw new Error('Unterminated quoted value in inline array');
  parts.push(current.trim());
  return parts.filter((part) => part !== '').map(parseScalar);
}



/**
 * Parse a Markdown file with a flat YAML frontmatter block.
 * Supported values: quoted/plain strings, numbers, booleans, null, inline
 * arrays and block string arrays. Nested maps and block scalars are rejected.
 */
export function parseFrontmatter(text) {
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  const lines = source.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') {
    return { data: {}, body: source, hasFrontmatter: false };
  }
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) throw new Error('Unterminated frontmatter block (missing closing ---)');

  const data = {};
  for (let i = 1; i < end; i += 1) {
    const rawLine = lines[i];
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (/^\s/.test(rawLine)) {
      throw new Error(`Unsupported frontmatter nesting at line ${i + 1}: ${rawLine}`);
    }
    const match = /^([A-Za-z0-9_.-]+):(.*)$/.exec(line);
    if (!match) throw new Error(`Invalid frontmatter line ${i + 1}: ${rawLine}`);
    const key = match[1];
    const value = match[2].trim();

    if (value === '|' || value === '>' || value.startsWith('|') || value.startsWith('>')) {
      throw new Error(`Block scalars are not supported (frontmatter key "${key}")`);
    }

    if (value === '') {
      const items = [];
      let j = i + 1;
      for (; j < end; j += 1) {
        const candidate = lines[j];
        const trimmed = candidate.trim();
        if (!trimmed) continue;
        if (/^\s*-\s+/.test(candidate)) {
          items.push(parseScalar(candidate.replace(/^\s*-\s+/, '')));
          continue;
        }
        if (/^\s+/.test(candidate)) {
          throw new Error(`Unsupported nested mapping under frontmatter key "${key}"`);
        }
        break;
      }
      if (items.length > 0) {
        data[key] = items;
        i = j - 1;
      } else {
        data[key] = '';
      }
      continue;
    }

    if (value.startsWith('[')) {
      if (!value.endsWith(']')) {
        throw new Error(`Unterminated inline array for frontmatter key "${key}"`);
      }
      data[key] = splitInlineArray(value);
      continue;
    }

    data[key] = parseScalar(value);
  }

  const body = lines.slice(end + 1).join('\n').replace(/^\n/, '');
  return { data, body, hasFrontmatter: true };
}



function quoteScalar(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Frontmatter numbers must be finite');
    return String(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value === null || value === undefined) return '""';
  const str = String(value);
  if (/[\r\n]/.test(str)) {
    throw new Error('Frontmatter values must be single-line; put long text in the Markdown body');
  }
  if (
    str === ''
    || /^\s|\s$/.test(str)
    || /^(?:true|false|null|~|-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)$/i.test(str)
    || /[:#\[\]{}",&*!|>'"%@`]/.test(str)
    || /^[-?]/.test(str)
  ) {
    return JSON.stringify(str);
  }
  return str;
}



/**
 * Serialize flat frontmatter. Arrays become inline arrays; nested objects and
 * multi-line strings are rejected so the on-disk format stays parseable.
 */
export function serializeFrontmatter(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('serializeFrontmatter expects a plain object');
  }
  const keys = [
    ...FRONTMATTER_FIELDS.filter((key) => key in obj),
    ...Object.keys(obj).filter((key) => !FRONTMATTER_FIELDS.includes(key)),
  ];
  const lines = ['---'];
  for (const key of keys) {
    if (!/^[A-Za-z0-9_.-]+$/.test(key)) {
      throw new Error(`Invalid frontmatter key "${key}"`);
    }
    const value = obj[key];
    if (Array.isArray(value)) {
      const items = value.map((item) => {
        if (item !== null && typeof item === 'object') {
          throw new Error(`Frontmatter array "${key}" only supports scalar items`);
        }
        return quoteScalar(item);
      });
      lines.push(`${key}: [${items.join(', ')}]`);
      continue;
    }
    if (value !== null && typeof value === 'object') {
      throw new Error(`Unsupported nested object for frontmatter key "${key}"`);
    }
    lines.push(`${key}: ${quoteScalar(value)}`);
  }
  lines.push('---', '');
  return lines.join('\n');
}
