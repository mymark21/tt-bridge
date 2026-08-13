#!/usr/bin/env bash
# P0-3 / P2-8: deterministic(-ish) build of the two release zips + SHA-256 sums.
# Given the same toolchain (same zip/Info-ZIP version), this produces byte-stable
# archives: fixed mtimes, sorted entries, no extra attributes, no dir entries.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
cd "$here"
STAMP=200001010000   # touch -t format: CCYYMMDDhhmm

build() {
  local srcdir="$1" root="$2" out="$3"
  rm -f "$here/$out"
  (
    cd "$srcdir"
    # normalize mtimes so the archive is reproducible
    find "$root" -exec touch -t "$STAMP" {} +
    # add files in a stable, sorted order
    find "$root" -type f | LC_ALL=C sort | zip -qX -D "$here/$out" -@
  )
}

build x-cli tt-bridge-cli               tt-bridge-cli.zip
build x-ext tt-bridge-chrome-extension  tt-bridge-extension.zip

shasum -a 256 tt-bridge-cli.zip tt-bridge-extension.zip > SHA256SUMS.txt
echo "Built:"
cat SHA256SUMS.txt
