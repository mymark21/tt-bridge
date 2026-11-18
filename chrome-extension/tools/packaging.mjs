#!/usr/bin/env node

/**
 * Shared packaging helpers for tt-bridge release artifacts.
 *
 * A packaged extension only works if it ships everything `manifest.json` points
 * at: the built `dist/`, the icons, the manifest itself, and every resource the
 * manifest exposes to web pages. v1.4.0 added the bootstrap hot-reload page
 * (`reload.html` / `reload.js`) exactly that way, and a hardcoded file list
 * silently dropped it from the release zip. The manifest is the source of truth
 * here, and a declared-but-missing file is an error rather than a silent gap.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Entries every packaged extension needs, relative to the extension root. */
export const BASE_ENTRIES = ['dist', 'icons', 'manifest.json'];

const GLOB_CHARS = /[*?[\]{}]/;
const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:/i;

/** MV2 declares bare path strings; MV3 declares `{ resources: [...] }` objects. */
export function declaredWebResources(manifest) {
  const declared = Array.isArray(manifest.web_accessible_resources)
    ? manifest.web_accessible_resources
    : [];

  const resources = [];
  for (const entry of declared) {
    if (typeof entry === 'string') {
      resources.push(entry);
    } else if (entry && Array.isArray(entry.resources)) {
      for (const resource of entry.resources) {
        if (typeof resource === 'string') resources.push(resource);
      }
    }
  }
  return resources;
}

/**
 * Extension-root files declared in `web_accessible_resources` that BASE_ENTRIES
 * do not already cover. Throws on anything that cannot be resolved to a real
 * file, so an incomplete package is never produced.
 */
export function manifestResourceEntries(rootDir, manifest) {
  const entries = [];

  for (const resource of declaredWebResources(manifest)) {
    const relative = String(resource).trim().replace(/^[/\\]+/, '');
    if (!relative) continue;

    // Already shipped as part of dist/ or icons/.
    if (BASE_ENTRIES.some((base) => relative === base || relative.startsWith(`${base}/`))) {
      continue;
    }

    if (GLOB_CHARS.test(relative)) {
      throw new Error(
        `Cannot stage web_accessible_resources pattern "${resource}": list the files explicitly so the `
        + 'packaged extension stays complete.',
      );
    }
    if (ABSOLUTE_URL.test(relative)) {
      throw new Error(
        `Cannot stage web_accessible_resources URL "${resource}": only extension-root paths belong in the package.`,
      );
    }

    const absolute = path.resolve(rootDir, relative);
    if (!absolute.startsWith(rootDir + path.sep)) {
      throw new Error(`web_accessible_resources entry "${resource}" escapes the extension root.`);
    }
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      throw new Error(
        `web_accessible_resources entry "${resource}" is declared in manifest.json but missing on disk.`,
      );
    }
    if (!entries.includes(relative)) {
      entries.push(relative);
    }
  }

  return entries;
}

/**
 * Copy the complete runtime file set of the extension into `targetDir`.
 * Returns the manifest that was staged plus the staged entry list.
 */
export function stageExtension(rootDir, targetDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, 'manifest.json'), 'utf8'));
  const extraEntries = manifestResourceEntries(rootDir, manifest);

  fs.mkdirSync(targetDir, { recursive: true });

  for (const entry of BASE_ENTRIES) {
    const source = path.join(rootDir, entry);
    if (!fs.existsSync(source)) {
      throw new Error(`Missing ${entry} in ${rootDir}; run "npm run build" before packaging.`);
    }
    const destination = path.join(targetDir, entry);
    if (fs.statSync(source).isDirectory()) {
      fs.cpSync(source, destination, { recursive: true });
    } else {
      fs.copyFileSync(source, destination);
    }
  }

  for (const entry of extraEntries) {
    const destination = path.join(targetDir, entry);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(rootDir, entry), destination);
  }

  return { manifest, entries: [...BASE_ENTRIES, ...extraEntries] };
}

/** Entry names inside a zip archive (directories included, with trailing slash). */
export function listZipEntries(zipPath) {
  return execFileSync('unzip', ['-Z1', zipPath])
    .toString('utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Read a single file out of a zip archive, or null when it is absent. */
export function readZipFile(zipPath, entry) {
  const names = listZipEntries(zipPath);
  if (!names.includes(entry)) {
    return null;
  }
  return execFileSync('unzip', ['-p', zipPath, entry]).toString('utf8');
}

/**
 * Fail loudly when a produced archive is missing something it must contain.
 * `requiredEntries` are paths relative to the archive root (before `prefix`);
 * directories count as present when any entry lives underneath them.
 */
export function assertZipEntries(zipPath, requiredEntries, prefix = '') {
  const names = new Set(listZipEntries(zipPath));
  const missing = [];

  for (const requirement of requiredEntries) {
    const target = `${prefix}${requirement}`;
    const present = [...names].some((name) => name === target || name.startsWith(`${target}/`));
    if (!present) {
      missing.push(target);
    }
  }

  if (missing.length > 0) {
    throw new Error(`${path.basename(zipPath)} is incomplete, missing: ${missing.join(', ')}`);
  }

  return requiredEntries;
}
