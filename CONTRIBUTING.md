# Contributing to TT Bridge

Thanks for helping improve TT Bridge. This repository is the **public, stable edition** of the project (the `v1.0.x` line). It exists so existing users can keep installing a version that works, so compatibility comes before novelty here.

Newer features are developed in a separate private tree. See [PORTING.md](PORTING.md) for how the two trees relate.

## What we accept

Good candidates:

- Bug fixes and regressions in the current `v1.0.x` behavior.
- Compatibility fixes for supported Chrome and Node.js versions.
- Documentation, tests, and small usability improvements that do not change the extension/daemon protocol.

Out of scope for this repository:

- New product features from the private development line (including typing and later work).
- Breaking changes to the CLI commands, daemon endpoints, or extension message protocol.
- Raising the minimum Node.js version above 18.
- Binary-only changes, including edits to the release zips.

Open an issue before starting a large or behavior-changing contribution so we can confirm it belongs in the stable line.

## Ground rules

- Target the `main` branch. Do not open pull requests against tags or the release zips.
- Change source files, not build output. Do not edit `tt-bridge-extension.zip`, `tt-bridge-cli.zip`, `chrome-extension/releases/`, `chrome-extension/dist/`, or `node_modules/`. `scripts/build-release.sh` builds into `build/`; the committed root zips are the frozen v1.0.4 release assets and must not be overwritten by contributors.
- Do not bump versions. The maintainer bumps `chrome-extension/manifest.json`, `chrome-extension/package.json`, and `daemon/package.json` at release time.
- Behavior changes need tests. If a Chrome-only path cannot be unit-tested, describe the manual steps and result in the pull request.
- Never include credentials, cookies, browser profile data, or access tokens in an issue, pull request, log, or screenshot. Redact them.
- Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md). Do not open a public issue or pull request for a security bug.
- Accepted fixes may be forward-ported to the private development tree. By contributing, you agree that your change may be reused there.
- Contributions are accepted under the repository's license (CC BY-NC 4.0).

## Requirements

- Node.js 18 or newer (CI uses Node.js 22).
- npm.
- `zip` and `unzip` on `PATH` for building release artifacts.
- Google Chrome for manual extension testing.

## Set up

```bash
git clone https://github.com/mymark21/tt-bridge.git
cd tt-bridge

(cd chrome-extension && npm ci)
(cd daemon && npm ci --omit=dev)
```

## Build and test

Run the extension checks:

```bash
cd chrome-extension
npm run typecheck
npm test
npm run build
```

Run the full release build (this is what CI runs):

```bash
./scripts/build-release.sh
```

It builds the extension, packages both zips into the repository root, and verifies their contents. It expects a clean checkout and does not rely on pre-existing `node_modules`.

### Manual extension test

1. Run `cd chrome-extension && npm run build`.
2. Open `chrome://extensions`, enable Developer mode, and choose **Load unpacked**.
3. Select the `chrome-extension/` directory.
4. Use a dedicated Chrome profile for testing, never a profile with real accounts.
5. From the repository root, check the bridge:

   ```bash
   node daemon/bin/cli.mjs --help
   node daemon/bin/cli.mjs status
   ```

Include the commands you ran and their results in the pull request.

## Commit style

Use short, imperative, Conventional Commit-style messages with a scope where useful:

```text
fix(extension): reconnect after service worker restart
fix(cli): report a clear error when the daemon port is busy
docs: clarify release zip installation
test(extension): cover daemon discovery fallback ports
```

- One logical change per commit.
- Keep the subject under about 72 characters and do not end it with a period.
- Reference the issue in the body, for example `Refs #42`.
- Do not mix formatting-only churn with behavior changes.

## Pull requests

- Fill in the pull request template, including the testing checklist.
- Keep the change focused; unrelated cleanup belongs in a separate pull request.
- CI must pass. The workflow runs `scripts/build-release.sh` on Node.js 22.
- A maintainer reviews for compatibility, security, and test coverage. We aim to respond within five business days, but this is best effort.
- Maintainers may squash commits on merge.
- Address review feedback with additional commits rather than force-pushing over review history.
- A pull request may be closed if the change belongs in the private development line instead.

## Releases

Maintainers cut stable releases from `main`:

1. Bump the version in the three manifests listed above.
2. Run `./scripts/build-release.sh` (outputs land in `build/`).
3. Copy the validated `build/tt-bridge-extension.zip` and `build/tt-bridge-cli.zip` to the repository root only as part of a versioned release, and update the release tag/assets accordingly.
4. Tag `v1.0.x` and attach both zips to the GitHub release.

Release and promotion details are in [PORTING.md](PORTING.md).
