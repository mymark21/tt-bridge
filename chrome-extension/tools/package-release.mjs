#!/usr/bin/env node

/**
 * Rebuild the two archives published from the repository root (GitHub Release
 * assets: `tt-bridge-extension.zip` and `tt-bridge-cli.zip`).
 *
 * Pure Node plus the system `zip`/`unzip`, no third-party dependencies, so the
 * release artifacts are a single reproducible command instead of a manual
 * re-zip that drifts from the manifest (which is exactly how `reload.html` and
 * `reload.js` went missing from the packaged extension).
 *
 * Layouts (stable, installers depend on them):
 *   tt-bridge-extension.zip -> tt-bridge-chrome-extension/{manifest.json,dist/,icons/,reload.html,reload.js}
 *   tt-bridge-cli.zip       -> tt-bridge-cli/{bin/cli.mjs,bin/daemon.mjs,bin/chrome-profiles.mjs,bin/targets.mjs,bin/experience.mjs,bin/exp/*,package.json[,package-lock.json]}
 *
 * Pass `--out-dir <dir>` to write the archives somewhere other than the repo
 * root (the public build writes to build/, leaving tagged release assets alone).
 */


import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertZipEntries, readZipFile, stageExtension } from './packaging.mjs';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.resolve(toolsDir, '..');
const repoDir = path.resolve(extensionDir, '..');
const cliPackageDir = path.join(repoDir, 'daemon');
const require = createRequire(import.meta.url);

const EXTENSION_DIR_NAME = 'tt-bridge-chrome-extension';
const CLI_DIR_NAME = 'tt-bridge-cli';

function readArgValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : null;
}

const outDir = path.resolve(readArgValue('--out-dir') || repoDir);
fs.mkdirSync(outDir, { recursive: true });
const EXTENSION_ZIP = path.join(outDir, 'tt-bridge-extension.zip');
const CLI_ZIP = path.join(outDir, 'tt-bridge-cli.zip');

/** CLI payload shipped to users; `package-lock.json` is optional. */
const CLI_ENTRIES = [
  'bin/cli.mjs',
  'bin/daemon.mjs',
  'bin/chrome-profiles.mjs',
  'bin/targets.mjs',
  'bin/experience.mjs',
  'package.json',
  'package-lock.json',
];

/** bin/exp/*.mjs — the experience store's implementation modules. */
const CLI_DIR_GLOBS = ['bin/exp'];
const CLI_OPTIONAL_ENTRIES = new Set(['package-lock.json']);

/**
 * Runtime dependency vendored into the CLI archive. The README promises the zip
 * is installable offline (`npm install -g .` on an unrelated machine), so the
 * daemon's only dependency travels with it — a `node_modules` left behind by
 * whoever ran `npm install` locally is not shipped.
 */
const CLI_VENDORED_DEPENDENCY = 'ws';

function readJson(jsonPath) {
  return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
}

function zipDirectory(directory, zipPath) {
  fs.rmSync(zipPath, { force: true });
  execFileSync('zip', ['-qr', zipPath, path.basename(directory)], { cwd: path.dirname(directory) });
}

function stageCli(targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  const entries = [];

  for (const dirName of CLI_DIR_GLOBS) {
    const sourceDir = path.join(cliPackageDir, dirName);
    const files = fs.readdirSync(sourceDir).filter((f) => f.endsWith('.mjs'));
    if (!files.length) throw new Error(`Missing CLI payload directory: daemon/${dirName}`);
    for (const file of files) {
      const rel = `${dirName}/${file}`;
      const destination = path.join(targetDir, rel);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(sourceDir, file), destination);
      entries.push(rel);
    }
  }

  for (const entry of CLI_ENTRIES) {
    const source = path.join(cliPackageDir, entry);
    if (!fs.existsSync(source)) {
      if (CLI_OPTIONAL_ENTRIES.has(entry)) {
        continue;
      }
      throw new Error(`Missing CLI payload file: daemon/${entry}`);
    }
    const destination = path.join(targetDir, entry);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
    entries.push(entry);
  }

  // `require.resolve` honours daemon/node_modules first, then any hoisted install;
  // a miss means the archived CLI would crash on `daemon start`.
  let resolved;
  try {
    resolved = require.resolve(`${CLI_VENDORED_DEPENDENCY}/package.json`, { paths: [cliPackageDir] });
  } catch {
    throw new Error(
      `Cannot vendor ${CLI_VENDORED_DEPENDENCY}: run "npm install" in daemon/ first.`,
    );
  }
  const vendoredEntry = `node_modules/${CLI_VENDORED_DEPENDENCY}`;
  fs.cpSync(path.dirname(resolved), path.join(targetDir, vendoredEntry), { recursive: true });
  entries.push(`${vendoredEntry}/`);

  return entries;
}

function packageRelease() {
  const manifest = readJson(path.join(extensionDir, 'manifest.json'));
  const extensionPackage = readJson(path.join(extensionDir, 'package.json'));
  const cliPackage = readJson(path.join(cliPackageDir, 'package.json'));

  if (manifest.version !== extensionPackage.version) {
    throw new Error(
      `Version mismatch: manifest.json is ${manifest.version}, package.json is ${extensionPackage.version}.`,
    );
  }
  if (manifest.version !== cliPackage.version) {
    throw new Error(
      `Version mismatch: manifest.json is ${manifest.version}, daemon/package.json is ${cliPackage.version}. `
      + 'Both archives ship as one release and must carry the same version.',
    );
  }

  // Build before staging: dist/ is gitignored, so a stale build silently ships
  // old code under a new version number.
  execFileSync('npm', ['run', 'build'], { cwd: extensionDir, stdio: 'inherit' });

  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-bridge-release-'));
  const extensionStage = path.join(stagingRoot, EXTENSION_DIR_NAME);
  const cliStage = path.join(stagingRoot, CLI_DIR_NAME);

  try {
    const staged = stageExtension(extensionDir, extensionStage);
    const cliEntries = stageCli(cliStage);

    zipDirectory(extensionStage, EXTENSION_ZIP);
    zipDirectory(cliStage, CLI_ZIP);

    // Verify the archives themselves, not just the staging directories.
    assertZipEntries(EXTENSION_ZIP, staged.entries, `${EXTENSION_DIR_NAME}/`);
    assertZipEntries(CLI_ZIP, cliEntries, `${CLI_DIR_NAME}/`);

    const packagedManifest = readZipFile(EXTENSION_ZIP, `${EXTENSION_DIR_NAME}/manifest.json`);
    if (!packagedManifest || JSON.parse(packagedManifest).version !== manifest.version) {
      throw new Error(
        `${path.basename(EXTENSION_ZIP)} does not carry manifest version ${manifest.version}.`,
      );
    }

    console.log(`Extension payload: ${staged.entries.join(', ')}`);
    console.log(`CLI payload: ${cliEntries.join(', ')}`);
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
}

packageRelease();
console.log(EXTENSION_ZIP);
console.log(CLI_ZIP);
