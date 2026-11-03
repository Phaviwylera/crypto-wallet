#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIN="f6b85a19411e61258ad6ecc5af7d20d521fdb7d7"
SOURCE="${PZSOLVE_SOURCE_DIR:-$ROOT/.runtime/bitcoin-puzzle-solver}"
BIN_DIR="${PZSOLVE_BIN_DIR:-$ROOT/.runtime/bin}"
JOBS="${PZSOLVE_BUILD_JOBS:-2}"

if [[ ! -d "$SOURCE/.git" ]]; then
  rm -rf "$SOURCE"
  mkdir -p "$(dirname "$SOURCE")"
  git clone https://github.com/boulayo/bitcoin-puzzle-solver.git "$SOURCE"
fi

cd "$SOURCE"
git fetch origin main
git checkout "$PIN"
make -j"$JOBS"
mkdir -p "$BIN_DIR"
cp build/pzsolve "$BIN_DIR/pzsolve"
chmod 700 "$BIN_DIR/pzsolve"
"$BIN_DIR/pzsolve" selftest
printf '\nInstalled validated native runner at %s\n' "$BIN_DIR/pzsolve"
printf 'Restart the Seedlab Vite server if it was already running.\n'
