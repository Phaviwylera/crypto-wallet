#!/usr/bin/env bash
# Builds a deployment zip for the scan Lambda into ../infra/seedlab-scan.zip
set -euo pipefail

cd "$(dirname "$0")"
ROOT="$(cd .. && pwd)"
OUT_DIR="$(mktemp -d)"
ZIP_PATH="$ROOT/infra/seedlab-scan.zip"

echo "Packaging Lambda into $OUT_DIR ..."
cp -r index.js lambda.js lib package.json "$OUT_DIR"/
cd "$OUT_DIR"
npm install --omit=dev --no-audit --no-fund --silent

rm -f "$ZIP_PATH"
(cd "$OUT_DIR" && zip -r -q "$ZIP_PATH" .)
rm -rf "$OUT_DIR"
echo "Built $ZIP_PATH"
