# Source provenance — public v1.0.x line

This repository's source tree is the **community-reviewable baseline for the
public v1.0.x line**. It is intentionally pre-typing and contains none of the
private development features.

## v1.0.4 (frozen)

The published `v1.0.4` release assets were built from an earlier local snapshot
that is no longer on disk. They remain available under tag `v1.0.4` and are not
rebuilt or replaced.

## v1.0.5 (security maintenance, artifact-based)

`v1.0.5` is a security maintenance release built from the **published v1.0.4
binaries** plus the reviewed hardening from PR #1. It is not built from this
source tree.

The source tree contains equivalent security patches (daemon auth, Host/Origin
checks, body/pending caps, separate WebSocket payload cap, `file://` blocking,
debugger detach), but it is still not byte-equivalent to the v1.0.5 binaries:

- the published extension bundle contains `getHumanWindowId`,
  `resolveHumanTabId`, and `listHumanWebTabs`; this source tree does not;
- the published CLI bundles `ws@8.21.0`, while this tree's lockfile is
  `ws@8.20.0`;
- `scripts/build-release.sh` builds from this tree into `build/`; it does not
  reproduce the v1.0.5 assets.

## What this means for contributions

- PRs target this source tree and are validated with
  `scripts/build-release.sh`.
- The build script writes to `build/` and never overwrites the committed root
  zips.
- The first **fully source-built** release will be a new version (`v1.0.6`),
  after compatibility review and a reproducible-build check. That release will
  make source and assets consistent.
- Until then, the root zips are the current v1.0.5 distribution artifacts and
  the source tree is the community development baseline.
