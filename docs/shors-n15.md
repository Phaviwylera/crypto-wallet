# Shor N=15 Quantum Lab

An additive, educational implementation of Shor's algorithm for the fixed integer **N = 15**.

- Browser page: `/quantum.html` (also `/quantum` on Vercel).
- Python/Qiskit implementation: `scripts/shors_algorithm.py`.
- Optional local simulator API: `server/quantum-api.mjs` (port 8789).
- Browser simulator: `src/quantum/shor-core.js` (exact classical statevector simulation of the same 12-qubit compiled circuit).

**Scope boundary:** this lab factors the constant 15. It has no address, public-key, private-key, mnemonic or wallet input, performs no balance checks, and contains no ECC/ECDLP attack code. It runs on local simulators only, not quantum hardware. The existing wallet exporter, native export service, auditor and puzzle processes are unchanged.

## Quick start

```bash
# Browser mode needs only the normal frontend:
npm ci
npm run dev
# open http://localhost:5173/quantum.html

# Optional real Qiskit/Aer execution (isolated Python environment):
bash scripts/setup-shors-lab.sh
npm run quantum:shor -- --base 7 --seed 42 --shots 128
npm run quantum:shor -- --base 7 --seed 42 --shots 128 --json

# Optional API used by the page's "Local Qiskit Aer" mode:
npm run server:quantum
# In another terminal: npm run dev
# The Vite dev server proxies /api/quantum -> http://localhost:8789.
```

`setup-shors-lab.sh` creates `.runtime/quantum-venv` and installs the pinned packages in `requirements-quantum.txt`. It does not install into the system Python, rebuild the native exporter, or touch any wallet service. `.runtime/` is gitignored.

## What the page does

1. Choose **Browser statevector** or **Local Qiskit Aer**.
2. Choose a coprime base `a` (2, 4, 7, 8, 11, 13) or Auto.
3. Set shots, max attempts and an optional seed.
4. Run the hybrid pipeline and inspect:
   - counting-register phase distribution,
   - measured bitstring and phase `s/r`,
   - continued-fraction candidate denominator,
   - validated period `r` (including small-multiple lifting),
   - `x = a^(r/2) mod 15`,
   - `gcd(x ± 1, 15)` and the verified factor pair `3 × 5 = 15`.
5. Export the result as JSON.

Browser mode is a classical simulation and is labeled as such. It works on static Vercel hosting without Python. Qiskit mode calls the optional local API; if the API is not running, the page shows setup instructions instead of pretending to have run quantum hardware.

## Python CLI

```bash
.runtime/quantum-venv/bin/python scripts/shors_algorithm.py \
  --base 7 --seed 42 --shots 128 --max-attempts 10
```

Options:

| Option | Default | Range |
|---|---:|---|
| `--base` | random coprime base per attempt | 2, 4, 7, 8, 11, 13 |
| `--seed` | random | 0 … 4294967295 |
| `--shots` | 1 | 1 … 1024 |
| `--max-attempts` | 10 | 1 … 10 |
| `--json` | off | machine-readable result |

Exit codes: `0` factors found, `1` no factors within the attempt limit, `2` invalid input or simulator error.

The Python module exposes the same building blocks:

```python
from scripts.shors_algorithm import (
    c_amod15, qft_dagger, build_period_circuit,
    run_period_finder, period_finder, infer_period,
    factors_from_period, shors_algorithm,
)
```

`period_finder(a, N, shots=1)` returns a float phase for compatibility with the original snippet. `run_period_finder` returns the richer evidence dictionary (samples, counts, versions). `shors_algorithm(N=15)` returns `(3, 5)` or `None`; non-15 moduli raise `ValueError`.

## Local API

The API is independent of `server/index.js` and the scalar-export service.

```bash
npm run server:quantum
# default: http://127.0.0.1:8789
```

Environment variables:

- `QUANTUM_PORT` (default 8789)
- `QUANTUM_HOST` (default 127.0.0.1)
- `QUANTUM_PYTHON` (override Python executable)

Endpoints:

- `GET /api/quantum/health` — simulator availability and Qiskit/Aer versions.
- `POST /api/quantum/shor` — JSON body `{ "N": 15, "base": 7, "seed": 42, "shots": 128, "maxAttempts": 5 }`.

Safety limits: fixed N=15, bounded options, request body ≤ 4 KiB, one simulation at a time, process timeout, no shell interpolation, no arbitrary code or modulus input. The API returns `hardware: false`.

## Corrections made to the original snippet

The pasted code was close, but several issues would have produced wrong results or failed at runtime:

1. `math.fraction` does not exist. Use `fractions.Fraction(...).limit_denominator(...)`.
2. `factor2 = gcd(x + 1, N)` is not the cofactor. Once a nontrivial factor `p` is found, the cofactor is `N // p`, and the product is verified.
3. Continued fractions can return a proper divisor of the true order (e.g. phase `1/2` for order 4). The implementation validates `a^r ≡ 1 mod N` and tries small multiples.
4. `N` was accepted but the circuit was hard-coded for 15. The lab explicitly rejects any modulus other than 15.
5. Zero-phase measurements (`s = 0`) are retried instead of being treated as a period.
6. `numpy` was imported only for π; `math.pi` is used.
7. Aer requires the custom controlled modular-multiplication gates to be transpiled before execution; the CLI does this.

## Circuit

- 8 counting qubits + 4 target qubits = 12 qubits.
- Target initialized to `|0001⟩ = 1`.
- Counting qubits prepared with Hadamards.
- Controlled `a^(2^q) mod 15` compiled from SWAP/X gates (`c_amod15`).
- Inverse QFT on the counting register (`qft_dagger`).
- Measure counting register; phase ≈ `s/r`.

For N=15 the possible orders are:

| a | order r |
|---:|---:|
| 2 | 4 |
| 4 | 2 |
| 7 | 4 |
| 8 | 4 |
| 11 | 2 |
| 13 | 4 |

Every successful run returns the nontrivial factors `(3, 5)`.

## Tests

```bash
npm run test:quantum          # JavaScript core + API + integration contracts
npm run test:quantum:python   # Python classical + real Qiskit/Aer tests (after setup)
npm run test:security         # existing auditor suite, unchanged
npm run test:search           # existing search/export suites, unchanged
npm run build                 # emits dist/index.html, dist/auditor.html, dist/quantum.html
```

CI workflow: `.github/workflows/quantum-lab-tests.yml`.

A real captured Qiskit/Aer result is checked in at `examples/shor-n15-result.json` (`success: true`, `factors: [3, 5]`, `backend: "qiskit-aer"`, `hardware: false`).

## Sources and references

- Qiskit Textbook, Shor's algorithm: <https://github.com/Qiskit/textbook> (the N=15 compiled `c_amod15` / `qft_dagger` exercise this lab corrects and hardens).
- Qiskit Aer simulator: <https://github.com/Qiskit/qiskit-aer>.
- P. W. Shor, "Algorithms for quantum computation: discrete logarithms and factoring," FOCS 1994.

## Deployment notes

- **Static Vercel:** browser statevector mode works out of the box. `/quantum` and `/quantum.html` rewrite to `quantum.html` before the SPA catch-all.
- **Local Qiskit mode:** run `npm run server:quantum` alongside the dev server. The Vite proxy forwards `/api/quantum` to the loopback API.
- **Production server:** if you want Qiskit mode behind the production Node server, mount `registerQuantumRoutes(app)` from `server/quantum-api.mjs` in a separate deployment or reverse-proxy `/api/quantum` to the quantum service. This PR does not modify `server/index.js`.
