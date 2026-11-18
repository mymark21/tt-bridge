#!/usr/bin/env bash
# Build the release artifacts from the committed source trees.
#
# Outputs (written to build/, never committed to the repository):
#   build/tt-bridge-extension.zip - tt-bridge-chrome-extension/{manifest.json,dist/,icons/,reload.html,reload.js}
#   build/tt-bridge-cli.zip       - tt-bridge-cli/{bin/,package.json,package-lock.json,node_modules/ws}
#   build/SHA256SUMS.txt          - checksums uploaded as a release asset
#
# Packaging itself lives in chrome-extension/tools/package-release.mjs; this
# script only prepares dependencies, runs the test suites and then delegates to
# it with --out-dir. Keeping one staging implementation means the version
# checks and the archive manifest cannot drift between local builds and CI.
#
# Requirements: node >= 18, npm, zip, unzip.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
EXT_DIR="${ROOT_DIR}/chrome-extension"
DAEMON_DIR="${ROOT_DIR}/daemon"
OUT_DIR="${ROOT_DIR}/build"

for tool in node npm zip unzip; do
  command -v "${tool}" >/dev/null 2>&1 || {
    echo "error: required tool not found: ${tool}" >&2
    exit 1
  }
done

echo "==> Checking out extension dependencies"
(
  cd "${EXT_DIR}"
  npm ci
)

echo "==> Typechecking and testing extension"
(
  cd "${EXT_DIR}"
  npm run typecheck
  npm test
)

echo "==> Checking out daemon dependencies and running tests"
(
  cd "${DAEMON_DIR}"
  npm ci
  npm test
)

echo "==> Packaging release archives"
# package-release.mjs builds dist/ itself before staging, so a stale bundle
# cannot slip into the zip under a new version number.
node "${ROOT_DIR}/chrome-extension/tools/package-release.mjs" --out-dir "${OUT_DIR}"

echo "==> SHA-256"
(
  cd "${OUT_DIR}"
  shasum -a 256 tt-bridge-extension.zip tt-bridge-cli.zip > SHA256SUMS.txt
  cat SHA256SUMS.txt
)

echo "extension: -> build/tt-bridge-extension.zip ($(du -h "${OUT_DIR}/tt-bridge-extension.zip" | cut -f1))"
echo "cli:       -> build/tt-bridge-cli.zip ($(du -h "${OUT_DIR}/tt-bridge-cli.zip" | cut -f1))"
