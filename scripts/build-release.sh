#!/usr/bin/env bash
# Build the v1.0.x release artifacts from a clean checkout.
#
# Outputs (written to the repository root):
#   build/tt-bridge-extension.zip - unpacked Chrome extension (dist/, icons/, manifest.json)
#   build/tt-bridge-cli.zip       - self-contained daemon + CLI (tt-bridge-cli/)
#
# The committed root zips are the immutable v1.0.4 release artifacts. This
# script writes to build/ and never overwrites them.
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

EXT_VERSION="$(cd "${EXT_DIR}" && node -p "require('./manifest.json').version")"
PKG_VERSION="$(cd "${EXT_DIR}" && node -p "require('./package.json').version")"
if [[ "${EXT_VERSION}" != "${PKG_VERSION}" ]]; then
  echo "error: extension version mismatch: manifest ${EXT_VERSION}, package ${PKG_VERSION}" >&2
  exit 1
fi

echo "==> Building Chrome extension v${EXT_VERSION}"
(
  cd "${EXT_DIR}"
  npm ci
  npm run typecheck
  npm test
  npm run build
  npm run package:zip
)

EXT_ZIP="${EXT_DIR}/releases/v${EXT_VERSION}.zip"
if [[ ! -s "${EXT_ZIP}" ]]; then
  echo "error: extension package not produced: ${EXT_ZIP}" >&2
  exit 1
fi
mkdir -p "${OUT_DIR}"
rm -f "${OUT_DIR}/tt-bridge-extension.zip"
cp "${EXT_ZIP}" "${OUT_DIR}/tt-bridge-extension.zip"

CLI_VERSION="$(cd "${DAEMON_DIR}" && node -p "require('./package.json').version")"
echo "==> Building CLI v${CLI_VERSION}"
(
  cd "${DAEMON_DIR}"
  npm ci --omit=dev
)

STAGE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/tt-bridge-release.XXXXXX")"
trap 'rm -rf "${STAGE_DIR}"' EXIT

CLI_STAGE="${STAGE_DIR}/tt-bridge-cli"
mkdir -p "${CLI_STAGE}/bin" "${CLI_STAGE}/node_modules"
cp "${DAEMON_DIR}/bin/cli.mjs" "${CLI_STAGE}/bin/cli.mjs"
cp "${DAEMON_DIR}/bin/daemon.mjs" "${CLI_STAGE}/bin/daemon.mjs"
cp "${DAEMON_DIR}/package.json" "${CLI_STAGE}/package.json"
cp "${DAEMON_DIR}/package-lock.json" "${CLI_STAGE}/package-lock.json"
cp -R "${DAEMON_DIR}/node_modules/ws" "${CLI_STAGE}/node_modules/ws"
chmod +x "${CLI_STAGE}/bin/cli.mjs" "${CLI_STAGE}/bin/daemon.mjs"

rm -f "${OUT_DIR}/tt-bridge-cli.zip"
(
  cd "${STAGE_DIR}"
  zip -qr "${OUT_DIR}/tt-bridge-cli.zip" tt-bridge-cli
)

echo "==> Verifying artifacts"
for zip_file in "${OUT_DIR}/tt-bridge-extension.zip" "${OUT_DIR}/tt-bridge-cli.zip"; do
  [[ -s "${zip_file}" ]] || {
    echo "error: missing or empty artifact: ${zip_file}" >&2
    exit 1
  }
  unzip -tq "${zip_file}" >/dev/null
done

unzip -Z1 "${OUT_DIR}/tt-bridge-extension.zip" | grep -q 'dist/background\.js$' || {
  echo "error: extension zip is missing dist/background.js" >&2
  exit 1
}
unzip -Z1 "${OUT_DIR}/tt-bridge-cli.zip" | grep -q 'tt-bridge-cli/bin/cli\.mjs$' || {
  echo "error: CLI zip is missing tt-bridge-cli/bin/cli.mjs" >&2
  exit 1
}

echo "extension: v${EXT_VERSION} -> tt-bridge-extension.zip ($(du -h "${OUT_DIR}/tt-bridge-extension.zip" | cut -f1))"
echo "cli:       v${CLI_VERSION} -> tt-bridge-cli.zip ($(du -h "${OUT_DIR}/tt-bridge-cli.zip" | cut -f1))"
