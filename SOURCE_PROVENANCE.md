# Source provenance — public v1.0.x line

This repository's source tree is the **community-reviewable baseline for the
public v1.0.x line**. It is intentionally pre-typing and contains none of the
private development features.

## Important: it is not byte-equivalent to the published v1.0.4 zips

The published `v1.0.4` release assets (`tt-bridge-cli.zip`,
`tt-bridge-extension.zip`) were built from an earlier local snapshot that is no
longer on disk. The source tree here comes from commit `c23a3f7` (the last
pre-typing source baseline) and differs from those binaries:

- the published extension bundle contains `getHumanWindowId`,
  `resolveHumanTabId`, and `listHumanWebTabs`; this source tree does not;
- the published `cli.mjs` / `daemon.mjs` hashes differ from this tree;
- the published CLI bundles `ws@8.21.0`, while this tree's lockfile is
  `ws@8.20.0`;
- the published extension zip has a top-level `tt-bridge-chrome-extension/`
  directory, while the local build script produces a flat zip.

Do not claim that building this tree reproduces the published v1.0.4 assets.
The v1.0.4 tag, release assets, and root zips are kept as-is for existing users.

## What this means for contributions

- PRs should target this source tree and be validated with
  `scripts/build-release.sh`.
- The build script writes to `build/`; it never overwrites the committed
  v1.0.4 root zips.
- The first release built from this source will be a new version (`v1.0.5`),
  after compatibility review. That release will make source and assets
  consistent.
- Until then, the root zips remain the v1.0.4 distribution artifacts.
