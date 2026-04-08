#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(toolsDir, '..');
const releasesDir = path.join(rootDir, 'releases');
const releasesUnzipDir = path.join(rootDir, 'releases-unzip');
const manifestPath = path.join(rootDir, 'manifest.json');
const packageJsonPath = path.join(rootDir, 'package.json');

function readJson(jsonPath) {
  return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
}

const manifest = readJson(manifestPath);
const packageJson = readJson(packageJsonPath);

if (manifest.version !== packageJson.version) {
  throw new Error(
    `Version mismatch: manifest.json is ${manifest.version}, package.json is ${packageJson.version}.`,
  );
}

const versionTag = `v${manifest.version}`;
const zipPath = path.join(releasesDir, `${versionTag}.zip`);
const unpackedDir = path.join(releasesUnzipDir, versionTag);

function stageExtension(targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  fs.cpSync(path.join(rootDir, 'dist'), path.join(targetDir, 'dist'), { recursive: true });
  fs.cpSync(path.join(rootDir, 'icons'), path.join(targetDir, 'icons'), { recursive: true });
  fs.copyFileSync(manifestPath, path.join(targetDir, 'manifest.json'));
}

function packageExtension() {
  fs.mkdirSync(releasesDir, { recursive: true });
  fs.rmSync(releasesUnzipDir, { recursive: true, force: true });
  fs.mkdirSync(releasesUnzipDir, { recursive: true });
  fs.rmSync(zipPath, { force: true });

  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-brower-bridge-'));
  const stagingDir = path.join(stagingRoot, versionTag);

  try {
    stageExtension(stagingDir);
    execFileSync('zip', ['-qr', zipPath, '.'], { cwd: stagingDir });
    execFileSync('unzip', ['-oq', zipPath, '-d', unpackedDir]);
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
}

packageExtension();
console.log(zipPath);
console.log(unpackedDir);
