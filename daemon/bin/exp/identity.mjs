// experience/identity: site/action naming, URL canonicalization + privacy, error classification
import {
  tail,
} from './util.mjs';

// Lowercase fragments matched case-insensitively against the strings this repo
// actually emits (daemon.mjs, cli.mjs, cdp.ts, background.ts). Keep in sync with
// those call sites: hard-cased fragments missed four of the six documented env
// faults ("Another debugger is already attached" vs "Debugger is...").
export const ENV_ERROR_PATTERNS = [
  'pinned tab',                    // Pinned tab N is no longer available
  'extension not connected',
  'daemon is not running',
  'timed out starting local daemon',
  'another debugger is already attached',
  'debugger is already attached',
  'timed out waiting for result',
  'timed out after',
  'not connected',                 // Instance/Designated/Owner "... is not connected"
  'is currently disconnected',
  'fetch failed',
  'econnrefused',
  'econnreset',
  'operation was aborted',
];

export function classifyError(error) {
  if (!error) return 'page';
  const str = String(error);
  // The assertion script itself breaking (missing file, syntax error, throw,
  // async return) says nothing about the page: counting it as a page miss would
  // let a typo in an assert file demote a perfectly good entry.
  if (str.startsWith('assert-error:')) return 'env';
  const lowered = str.toLowerCase();
  for (const pattern of ENV_ERROR_PATTERNS) {
    if (lowered.includes(pattern)) return 'env';
  }
  return 'page';
}



const TRACKING_PARAM_RE = /^(?:utm_.*|fbclid|gclid)$/i;


const SENSITIVE_PARAM_RE = /^(?:token|key|secret|code|sig|signature|session|auth|password|passwd|access_token|id_token|refresh_token|api_key|apikey|jwt|sessionid|phpsessid|jsessionid|samlresponse|assertion|credential|client_secret|oauth_token|auth_token|access-token|authorization|x-amz-signature|x-amz-security-token|x-amz-credential)$/i;


const SENSITIVE_PARAM_PATTERN = /(?:token|secret|password|passwd|signature|credential|session|saml|assertion)/i;



function isSensitiveParam(key) {
  return SENSITIVE_PARAM_RE.test(key) || SENSITIVE_PARAM_PATTERN.test(key);
}



export function redactError(text, limit = 2000) {
  let value = String(text ?? '').replace(/\s+/g, ' ').trim();
  value = value.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]');
  value = value.replace(/\b[A-Za-z0-9_-]*(?:token|secret|password|passwd|session|auth|key|sig|credential|cookie)[A-Za-z0-9_-]*\s*[:=]\s*[^\s,;]+/gi, '[REDACTED]');
  value = value.replace(/([?&][^=&#\s]*(?:token|secret|password|passwd|session|auth|key|sig|credential)[^=&#\s]*=)[^&#\s]+/gi, '$1[REDACTED]');
  value = value.replace(/\/\/[^/@\s]+@/g, '//[REDACTED]@');
  return tail(value, limit);
}



// ── URL / intent identity ────────────────────────────────────────────

export function normalizeIntent(text, fallback = 'default') {
  const raw = String(text ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
  let slug = raw
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  slug = slug.slice(0, 64).replace(/-+$/g, '');
  return slug || fallback;
}



/**
 * Canonical URL: lowercase host, no default port, no fragment, no tracking
 * params, no trailing slash (except the root path).
 */
export function normalizeUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('URL is required');
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }
  url.hash = '';
  url.username = '';
  url.password = '';
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) {
    url.port = '';
  }
  const kept = [];
  for (const [key, value] of url.searchParams) {
    if (TRACKING_PARAM_RE.test(key) || isSensitiveParam(key)) continue;
    kept.push([key, value]);
  }
  kept.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  url.search = '';
  for (const [key, value] of kept) url.searchParams.append(key, value);
  let pathname = url.pathname || '/';
  if (pathname.length > 1) pathname = pathname.replace(/\/+$/, '');
  url.pathname = pathname || '/';
  return url.toString();
}



export function urlParts(raw) {
  const normalized = normalizeUrl(raw);
  const url = new URL(normalized);
  return {
    url: normalized,
    host: url.host.toLowerCase(),
    pathname: url.pathname,
    protocol: url.protocol,
  };
}



export function makeKey(host, intent) {
  return `${String(host || '').toLowerCase()}|${normalizeIntent(intent)}`;
}



export function entryId(host, slug) {
  return `${String(host || '').toLowerCase()}/${normalizeIntent(slug)}`;
}
