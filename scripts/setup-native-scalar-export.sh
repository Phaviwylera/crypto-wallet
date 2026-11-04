#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIN="f6b85a19411e61258ad6ecc5af7d20d521fdb7d7"
SOURCE="${SEEDLAB_ETH_EXPORT_SOURCE_DIR:-${PZSOLVE_SOURCE_DIR:-$ROOT/.runtime/bitcoin-puzzle-solver}}"
BIN_DIR="${SEEDLAB_ETH_EXPORT_BIN_DIR:-${PZSOLVE_BIN_DIR:-$ROOT/.runtime/bin}}"
JOBS="${SEEDLAB_ETH_EXPORT_BUILD_JOBS:-2}"
BINARY="$BIN_DIR/seedlab-eth-export"
TEMP_BINARY="$BIN_DIR/.seedlab-eth-export.tmp.$$"
SMOKE_DIR=""
cleanup() {
  rm -f "$TEMP_BINARY"
  if [[ -n "$SMOKE_DIR" ]]; then rm -rf "$SMOKE_DIR"; fi
}
trap cleanup EXIT

if [[ ! -d "$SOURCE/.git" ]]; then
  rm -rf "$SOURCE"
  mkdir -p "$(dirname "$SOURCE")"
  git clone https://github.com/boulayo/bitcoin-puzzle-solver.git "$SOURCE"
fi

cd "$SOURCE"
git fetch origin main
git checkout "$PIN"
make -j"$JOBS" lib
mkdir -p "$BIN_DIR"

cc -O3 -std=gnu11 -D_FILE_OFFSET_BITS=64 \
  -Wall -Wextra -Wshadow -Werror \
  -I"$SOURCE/lib/pzcore/include" \
  "$ROOT/native/seedlab-eth-export.c" "$SOURCE/build/libpzcore.a" \
  -o "$TEMP_BINARY" -pthread
chmod 700 "$TEMP_BINARY"
"$TEMP_BINARY" --selftest
VERSION_OUTPUT="$("$TEMP_BINARY" --version)"
if [[ "$VERSION_OUTPUT" != *"Native capabilities: all-entries,random-sample,wide-range-random-sample"* ]]; then
  printf 'The built exporter lacks wide-range random sampling; refusing to install it.\n' >&2
  exit 1
fi
# Prove the installed behavior, not just the version string: 32 rows from a
# 2^200-wide range must succeed even though the full range cannot be written.
SMOKE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/seedlab-eth-export-smoke.XXXXXX")"
"$TEMP_BINARY" --start 1 --end 340282366920938463463374607431768211456 \
  --sample 32 --threads 1 --chunk-size 8 --output "$SMOKE_DIR/wide-sample.txt" >/dev/null
if [[ "$(wc -c < "$SMOKE_DIR/wide-sample.txt")" -ne 3520 ]]; then
  printf 'Wide-range random-sample smoke test returned an unexpected size.\n' >&2
  exit 1
fi
printf 'Wide-range random-sample smoke test passed (32 rows from a 2^200-wide range).\n'
cp "$SOURCE/LICENSE" "$BIN_DIR/seedlab-eth-export.LICENSE.txt"
cp "$SOURCE/NOTICE" "$BIN_DIR/seedlab-eth-export.NOTICE.txt"
mv -f "$TEMP_BINARY" "$BINARY"
cleanup
trap - EXIT

printf '\nInstalled self-tested native Ethereum scalar exporter at %s\n' "$BINARY"
printf 'Run %s --version for copyright, license, warranty and modified-work notices.\n' "$BINARY"
printf 'Build source pinned to pzsolve commit %s.\n' "$PIN"
printf 'No puzzle campaign or Seedlab service was started, stopped or restarted.\n'
