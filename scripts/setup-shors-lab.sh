#!/usr/bin/env bash
# Optional Python environment for the educational N=15 Shor lab.
# Does not install, rebuild, start, stop, or modify any wallet/export service.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="$ROOT/.runtime/quantum-venv"
PYTHON="${PYTHON:-python3}"
if ! command -v "$PYTHON" >/dev/null 2>&1; then
  echo "Python 3.10+ is required (python3 or PYTHON=/path/to/python)." >&2
  exit 1
fi
"$PYTHON" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3,10) else "Python 3.10+ required")'
mkdir -p "$ROOT/.runtime"
if [ ! -x "$VENV/bin/python" ]; then
  "$PYTHON" -m venv "$VENV"
fi
"$VENV/bin/python" -m pip install --disable-pip-version-check -r "$ROOT/requirements-quantum.txt"
"$VENV/bin/python" "$ROOT/scripts/shors_algorithm.py" --base 7 --seed 42 --shots 8 --max-attempts 3
echo "Shor N=15 simulator ready: $VENV/bin/python"
echo "Run: npm run quantum:shor -- --base 7 --seed 42 --shots 128"
echo "Optional local API: npm run server:quantum"
