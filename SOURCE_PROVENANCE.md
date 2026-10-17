# Source provenance — public v1.0.x line

This repository's source tree is the **community-reviewable source for the
public v1.0.x line**. It is intentionally pre-typing and contains none of the
private development features.

## v1.0.4 (frozen)

The published `v1.0.4` release assets were built from an earlier local snapshot
that is no longer on disk. They remain available under tag `v1.0.4` and are not
rebuilt or replaced.

## v1.0.5 (aligned source and release)

`v1.0.5` is the current release. Its source tree in this repository is the
same tree used to produce the release assets:

- `chrome-extension/` — `manifest.json`, `dist/`, `icons/` (the shipped bundle)
- `daemon/` — `bin/cli.mjs`, `bin/daemon.mjs`, `package.json`, lockfile
- `scripts/build-release.sh` packages these exact trees into `build/`

Verified: extracting `build/tt-bridge-extension.zip` and
`build/tt-bridge-cli.zip` produces trees identical to the committed release
zips (`diff -r` empty), aside from zip metadata/timestamps.

The v1.0.5 extension source is the compiled `dist/background.js` bundle because
the original TypeScript source for the shipped v1.0.4 behavior is not
recoverable. TypeScript/Vite source returns in v1.0.6; until then, extension
changes are made directly to the shipped bundle.

## What this means for contributions

- PRs target this source tree and are validated with
  `scripts/build-release.sh` (outputs in `build/`).
- The build script never overwrites the committed root zips.
- The next release will restore a TypeScript build and reproducible-build
  checking; version and source will continue to match.
