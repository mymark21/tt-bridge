import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Cache for parsed Chrome profiles.
 * Local State is polled by daemon routes; 2s caching prevents disk thrashing.
 */
let cachedProfilesResult = null;
let cacheExpiresAt = 0;
const CACHE_TTL_MS = 2000;

/**
 * Resolve the path to Chrome's "Local State" file.
 * Prioritizes AGENT_BROWSER_BRIDGE_CHROME_DIR if set, then OS defaults.
 * @returns {string}
 */
export function getDefaultLocalStatePath() {
  const custom = process.env.AGENT_BROWSER_BRIDGE_CHROME_DIR?.trim();
  if (custom) {
    if (custom.endsWith('Local State')) {
      return custom;
    }
    return path.join(custom, 'Local State');
  }

  const platform = os.platform();
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library/Application Support/Google/Chrome/Local State');
  }
  if (platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'Google', 'Chrome', 'User Data', 'Local State');
  }
  // Linux and other Unixes
  return path.join(os.homedir(), '.config/google-chrome/Local State');
}

/**
 * Mask an email address for privacy (e.g. "t***@gmail.com").
 * @param {unknown} email
 * @returns {string}
 */
export function maskEmail(email) {
  if (typeof email !== 'string' || !email.includes('@')) {
    return '';
  }
  const [user, domain] = email.split('@');
  if (!user || !domain) {
    return '';
  }
  const first = user[0] || '';
  return `${first}***@${domain}`;
}

/**
 * Mask a Gaia ID for privacy (e.g. "1106***683").
 * @param {unknown} gaiaId
 * @returns {string}
 */
export function maskGaiaId(gaiaId) {
  if (typeof gaiaId !== 'string' || !gaiaId.trim()) {
    return '';
  }
  const str = gaiaId.trim();
  if (str.length <= 6) {
    return '***';
  }
  return `${str.slice(0, 4)}***${str.slice(-3)}`;
}

/**
 * Shorten a display name the same way the popup does: keep the first word and
 * the initial of the next one ("Terry Tang" -> "Terry T."). `/status` is
 * unauthenticated, so it must not return the full profile name verbatim.
 * @param {unknown} name
 * @returns {string}
 */
export function maskProfileName(name) {
  if (typeof name !== 'string') {
    return '';
  }
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return '';
  }
  if (parts.length >= 2) {
    return `${parts[0]} ${parts[1][0].toUpperCase()}.`;
  }
  return `${parts[0]} ${parts[0][0].toUpperCase()}.`;
}

/**
 * Synchronous read of Chrome's Local State with retry and caching.
 * Chrome can rewrite Local State at runtime, so we perform up to 3 quick retries.
 * @param {boolean} [forceRefresh=false]
 * @returns {{ available: boolean, source: string, profiles: Array<{ dir: string, name: string, email: string, gaiaId: string, isDefaultName: boolean }> }}
 */
export function readChromeProfiles(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedProfilesResult && now < cacheExpiresAt) {
    return cachedProfilesResult;
  }

  const source = getDefaultLocalStatePath();
  const fallbackResult = {
    available: false,
    source,
    profiles: [],
  };

  if (!fs.existsSync(source)) {
    cachedProfilesResult = fallbackResult;
    cacheExpiresAt = now + CACHE_TTL_MS;
    return fallbackResult;
  }

  let content = null;
  // Retry up to 3 times in case Chrome is midway through an atomic write
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const raw = fs.readFileSync(source, 'utf8');
      content = JSON.parse(raw);
      break;
    } catch {
      // Small pause if possible before retry
    }
  }

  if (!content || typeof content !== 'object') {
    cachedProfilesResult = fallbackResult;
    cacheExpiresAt = now + CACHE_TTL_MS;
    return fallbackResult;
  }

  const infoCache = content.profile?.info_cache;
  if (!infoCache || typeof infoCache !== 'object') {
    const emptyResult = { available: true, source, profiles: [] };
    cachedProfilesResult = emptyResult;
    cacheExpiresAt = now + CACHE_TTL_MS;
    return emptyResult;
  }

  const profiles = [];
  for (const [dir, rawProfile] of Object.entries(infoCache)) {
    if (!rawProfile || typeof rawProfile !== 'object') {
      continue;
    }
    profiles.push({
      dir,
      name: typeof rawProfile.name === 'string' && rawProfile.name.trim() ? rawProfile.name.trim() : dir,
      email: typeof rawProfile.user_name === 'string' ? rawProfile.user_name.trim() : '',
      gaiaId: typeof rawProfile.gaia_id === 'string' ? rawProfile.gaia_id.trim() : '',
      isDefaultName: Boolean(rawProfile.is_using_default_name),
    });
  }

  const result = {
    available: true,
    source,
    profiles,
  };

  cachedProfilesResult = result;
  cacheExpiresAt = now + CACHE_TTL_MS;
  return result;
}

/**
 * Resolve the display name of a Chrome profile based on extension profile info.
 * Resolution hierarchy (highest priority first):
 * - Tier 0: user override name sent by the extension (`profileDescriptor.name`)
 * - Tier 1: exact match on gaiaId against Local State, unless the Chrome name is
 *   a default one (`isDefaultName === true`, e.g. "Profile 2")
 * - Tier 2: case-insensitive match on email against Local State user_name, with
 *   the same default-name rejection
 * - Tier 3: signed-out descriptor (no gaiaId, no email) when exactly one Chrome
 *   profile is also signed out — elimination, not a guess
 * - Else: '' (callers display the instance label with unknown profile marker; never guess).
 *
 * @param {unknown} profileDescriptor
 * @param {Array<{ dir: string, name: string, email: string, gaiaId: string, isDefaultName?: boolean }>} [profilesList]
 * @returns {string}
 */
export function resolveProfileName(profileDescriptor, profilesList = null) {
  if (!profileDescriptor || typeof profileDescriptor !== 'object') {
    return '';
  }

  const list = Array.isArray(profilesList) ? profilesList : readChromeProfiles().profiles;
  const gaiaId = typeof profileDescriptor.gaiaId === 'string' ? profileDescriptor.gaiaId.trim() : '';
  const email = typeof profileDescriptor.email === 'string' ? profileDescriptor.email.trim().toLowerCase() : '';
  const nameOverride = typeof profileDescriptor.name === 'string' ? profileDescriptor.name.trim() : '';

  // Tier 0: user override stored in extension
  if (nameOverride) {
    return nameOverride;
  }

  // Chrome's default names ("Profile 2", "Person 1") are directory names, not aliases.
  const isAlias = (entry) => Boolean(entry && entry.name && entry.isDefaultName !== true);

  // Tier 1: gaiaId
  if (gaiaId) {
    const match = list.find((p) => p.gaiaId && p.gaiaId === gaiaId);
    if (isAlias(match)) {
      return match.name;
    }
  }

  // Tier 2: email
  if (email) {
    const match = list.find((p) => p.email && p.email.toLowerCase() === email);
    if (isAlias(match)) {
      return match.name;
    }
  }

  // Tier 3: the extension reports no account at all. If Local State has exactly
  // one signed-out profile, the connection can only be that one. Two or more
  // signed-out profiles are indistinguishable here, so stay silent.
  if (!gaiaId && !email) {
    const signedOut = list.filter((p) => !p.gaiaId && !p.email);
    if (signedOut.length === 1 && isAlias(signedOut[0])) {
      return signedOut[0].name;
    }
  }

  return '';
}
