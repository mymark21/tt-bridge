#!/usr/bin/env bash
# Build the v1.0.x release artifacts from the committed source trees.
#
# The extension under chrome-extension/ and the CLI under daemon/ are shipped
# as-is: the extension dist/ is committed build output, and the CLI is plain
# ESM with a bundled ws dependency. Nothing is compiled or bundled here.
#
# Outputs (written to build/, never to the committed root zips):
#   build/tt-bridge-extension.zip - tt-bridge-chrome-extension/{manifest.json,dist/,icons/}
#   build/tt-bridge-cli.zip       - tt-bridge-cli/{bin/,package.json,package-lock.json,node_modules/ws}
#
# Requirements: node >= 18, npm, zip, unzip.

set -euo pipefail

EXPECTED_VERSION="1.0.6"

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

for required in \
  "${EXT_DIR}/manifest.json" \
  "${EXT_DIR}/dist/background.js" \
  "${EXT_DIR}/dist/popup.html" \
  "${DAEMON_DIR}/bin/cli.mjs" \
  "${DAEMON_DIR}/bin/daemon.mjs" \
  "${DAEMON_DIR}/package.json" \
  "${DAEMON_DIR}/package-lock.json"; do
  [[ -f "${required}" ]] || {
    echo "error: missing source file: ${required}" >&2
    exit 1
  }
done

EXT_VERSION="$(node -p "require('${EXT_DIR}/manifest.json').version")"
CLI_VERSION="$(node -p "require('${DAEMON_DIR}/package.json').version")"
if [[ "${EXT_VERSION}" != "${EXPECTED_VERSION}" ]]; then
  echo "error: extension version ${EXT_VERSION}, expected ${EXPECTED_VERSION}" >&2
  exit 1
fi
if [[ "${CLI_VERSION}" != "${EXPECTED_VERSION}" ]]; then
  echo "error: CLI version ${CLI_VERSION}, expected ${EXPECTED_VERSION}" >&2
  exit 1
fi

STAGE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/tt-bridge-release.XXXXXX")"
trap 'rm -rf "${STAGE_DIR}"' EXIT
mkdir -p "${OUT_DIR}"

EXT_STAGE="${STAGE_DIR}/tt-bridge-chrome-extension"
mkdir -p "${EXT_STAGE}"
cp "${EXT_DIR}/manifest.json" "${EXT_STAGE}/manifest.json"
cp -R "${EXT_DIR}/dist" "${EXT_STAGE}/dist"
cp -R "${EXT_DIR}/icons" "${EXT_STAGE}/icons"

echo "==> Packaging Chrome extension v${EXT_VERSION}"
rm -f "${OUT_DIR}/tt-bridge-extension.zip"
(
  cd "${STAGE_DIR}"
  zip -qr "${OUT_DIR}/tt-bridge-extension.zip" tt-bridge-chrome-extension
)

echo "==> Installing CLI dependencies"
(
  cd "${DAEMON_DIR}"
  npm ci --omit=dev
)

WS_VERSION="$(node -p "require('${DAEMON_DIR}/node_modules/ws/package.json').version")"
echo "==> Packaging CLI v${CLI_VERSION} (ws ${WS_VERSION})"
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
verify_zip() {
  local zip_file="$1"
  shift
  [[ -s "${zip_file}" ]] || {
    echo "error: missing or empty artifact: ${zip_file}" >&2
    exit 1
  }
  unzip -tq "${zip_file}" >/dev/null || {
    echo "error: corrupt zip archive: ${zip_file}" >&2
    exit 1
  }
  local entry
  for entry in "$@"; do
    unzip -Z1 "${zip_file}" | grep -qx "${entry}" || {
      echo "error: ${zip_file} is missing ${entry}" >&2
      exit 1
    }
  done
}

verify_zip "${OUT_DIR}/tt-bridge-extension.zip" \
  "tt-bridge-chrome-extension/manifest.json" \
  "tt-bridge-chrome-extension/dist/background.js" \
  "tt-bridge-chrome-extension/dist/popup.html" \
  "tt-bridge-chrome-extension/dist/assets/popup-BCbnAzCt.js" \
  "tt-bridge-chrome-extension/dist/assets/popup-CIwDS2fd.css" \
  "tt-bridge-chrome-extension/icons/icon-16.png" \
  "tt-bridge-chrome-extension/icons/icon-32.png" \
  "tt-bridge-chrome-extension/icons/icon-48.png" \
  "tt-bridge-chrome-extension/icons/icon-128.png"

verify_zip "${OUT_DIR}/tt-bridge-cli.zip" \
  "tt-bridge-cli/bin/cli.mjs" \
  "tt-bridge-cli/bin/daemon.mjs" \
  "tt-bridge-cli/package.json" \
  "tt-bridge-cli/package-lock.json" \
  "tt-bridge-cli/node_modules/ws/package.json" \
  "tt-bridge-cli/node_modules/ws/index.js"

echo "==> SHA-256"
shasum -a 256 "${OUT_DIR}/tt-bridge-extension.zip" "${OUT_DIR}/tt-bridge-cli.zip"

echo "extension: v${EXT_VERSION} -> build/tt-bridge-extension.zip ($(du -h "${OUT_DIR}/tt-bridge-extension.zip" | cut -f1))"
echo "cli:       v${CLI_VERSION} -> build/tt-bridge-cli.zip ($(du -h "${OUT_DIR}/tt-bridge-cli.zip" | cut -f1))"
