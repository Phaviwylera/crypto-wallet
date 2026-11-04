# Seedlab Security Auditor + Immunefi research workspace

A separate, additive page at **`/auditor.html`** for defensive wallet-security research. The existing wallet lab, scalar exporter, search workers, native APIs, download formats and EC2 services are unchanged. The only existing-page edit is a navigation link.

## What is included

- **Entropy auditor:** raw-byte import (binary/hex/base64/JSON), six synthetic fixtures, browser-worker analysis, bit/byte histograms, bit-position balance, NIST-style monobit and runs checks, chi-square, adjacent-byte correlation, repeated 16/32-byte blocks, gzip ratio, empirical entropy estimates, SHA-256 sample fingerprint and explicit limitations.
- **Source review:** local JavaScript AST plus multi-language heuristics for weak PRNGs, clock-derived seeds, short secret buffers and possible hardcoded secrets. Secure API references are recorded separately. Uploaded code is never executed.
- **Immunefi workspace:** official-page snapshot, wallet-specific vs conditional scope, paused-program warnings, web/app reward ceilings distinct from headline smart-contract rewards, shortlist, custom official-program bookmarks, six-item scope attestation with 24-hour expiry and private notes.
- **Report builder:** redacted evidence, root-cause/impact/reproduction/remediation fields, research attestations, local readiness gates, live Markdown preview and JSON/Markdown/HTML/ZIP exports.
- **Executable CLI:** the same core engines, recursive source scanning, demo, program snapshot and bundle integrity verification.
- **Tests:** statistical reference vectors, fixture behavior, input boundaries, scanner rules/redaction, workflow gates, storage privacy, report escaping, bundle integrity and tamper detection.

## Quick start (browser)

Requires Node.js 22+.

```sh
npm ci
npm run dev
```

Open **`http://localhost:5173/auditor.html`**. In the Arena live preview, open the same path on the preview host. The existing lab remains at `/`.

1. **Entropy auditor → Run synthetic audit.** Start with *Repeating block*, then compare *CSPRNG control* and *Fixed-seed MT19937*.
2. **Source review → Run training examples.** Compare the intentionally weak JS/Python fixtures with the secure Web Crypto fixture.
3. **Immunefi programs.** Select a program, open its official terms/scope, complete the checklist and record your review.
4. **Report builder.** Add exact asset/version, root cause, demonstrated impact, reproduction and remediation. Confirm the attestations only when true.
5. **Download evidence ZIP.** Extract it and run `node reproduce.mjs` for a synthetic fixture, or `node reproduce.mjs /path/to/original.bin` for an external sample.

No login, API key, bearer token or network connection is required for analysis. External program links open only when clicked.

## Quick start (CLI)

```sh
# Complete synthetic demonstration; writes reports/audit-demo/
npm run audit:demo

# Audit your own raw generator output (never a wallet secret)
npm run audit:entropy -- ./sample.bin --out ./reports/entropy
npm run audit:entropy -- ./sample.hex --format hex --out ./reports/entropy-hex

# Scan authorized source code (file or directory)
npm run audit:source -- ./authorized-source --out ./reports/source

# Verify a downloaded/exported bundle
npm run audit:verify -- ./reports/audit-demo/bundle.zip

# Inspect the official-page snapshot
npm run audit:programs
npm run audit:programs -- --json

# Regression suites
npm run test:security
npm run test:search
npm run test:export:native
npm run build
```

Each audit output directory contains `report.json`, `report.md`, `report.html` and `bundle.zip`; entropy/source runs also include their detailed JSON. The demo additionally writes `controls.json` with a fresh CSPRNG control and a fixed-seed MT19937 sample. Generated audit outputs are Git-ignored.

## Production execution

The auditor is a static multi-page Vite entry. It needs no new backend, database, queue or native process.

```sh
npm run build
npm start
```

Open `/auditor.html` on the Node server. The existing `server/index.js` already serves built static files. For the existing EC2 static deployment, the normal `seedlab-deploy` build publishes both `index.html` and `auditor.html`; no scalar-export installer rerun is required for this page. On Vercel, explicit `/auditor` and `/auditor.html` rewrites precede the existing SPA catch-all.

The page sets a restrictive CSP. In development, WebSocket connections are allowed for Vite HMR; analysis itself makes no network requests. Serve over HTTPS (or localhost) for Web Crypto and clipboard support.

## Data handling and limits

- Entropy: 1 KiB minimum, 8 MiB maximum, 64 KiB recommended. A single private key/recovery phrase is deliberately rejected as too small and is never an appropriate audit sample.
- Source: 250 files, 1 MiB/file, 12 MiB total; browser ZIPs additionally limited to 4 MiB compressed with unsafe paths rejected.
- Entropy runs in a dedicated worker. Source scanning never executes input.
- Reports contain sample digests/metrics and redacted source lines—not raw entropy or complete source files.
- localStorage holds only program selections, checklist attestations and notes. Samples, source and report fields are memory-only. **Clear local data** removes saved metadata and current evidence; downloaded files remain on disk.
- Bundle manifests use SHA-256 to detect accidental corruption/tampering. They are not signatures and do not prove authorship or vulnerability validity.

## Interpretation and research boundary

A statistical signal is a **lead**, not proof of exploitability. A clean result is **not** proof of security. Empirical entropy values describe the sample, not a certified generator bound. A predictable fixed-seed PRNG can pass statistical tests; source, seed provenance, platform fallbacks and release-build flags matter.

This tool does **not** search funded wallets, check balances, derive candidate private keys, reconstruct historical vulnerable-wallet ranges, access accounts or move funds. Use synthetic data, your own generator output, or explicit written authorization. Historical incidents such as Milk Sad and CVE-2023-31290 are references for defensive methodology, not new bounty targets.

## Immunefi snapshot and sources

Catalog retrieved **2026-11-04** from official pages. This is an editorial snapshot, not a live API. Status, scope and rewards can change; the official page at testing/submission time controls. Reward ceilings are not promises.

- 1inch — Wallet: https://immunefi.com/bug-bounty/1inch-wallet/information/ and https://immunefi.com/bug-bounty/1inch-wallet/scope/ — direct wallet scope; official production app-store builds; 24-hour discovery-to-report term; web/app critical ceiling $100,000 at snapshot.
- 0x: https://immunefi.com/bug-bounty/0x/information/ — conditional key-generation impact in web/app terms; $50,000 web/app critical ceiling, distinct from the $1,000,000 smart-contract headline.
- ENS: https://immunefi.com/bug-bounty/ens/information/ — conditional key-generation impact; $25,000 web/app critical reward calculation, distinct from the $250,000 smart-contract ceiling.
- Ava Labs: https://immunefi.com/bug-bounty/avalabs/information/ — displayed **Paused** at retrieval; tracking example only.
- Zerion: https://immunefi.com/bug-bounty/zerion/information/ — displayed **Paused** at retrieval; overview says users connect their own wallets.
- Platform rules: https://immunefi.com/rules/ — no exploitation, unauthorized rescue, already-public bug reports, high-traffic automated testing, or scanner-only reports without demonstrated impact.

The workspace does not log in to Immunefi, collect credentials, submit reports, contact projects or guarantee eligibility. It prepares a local draft; you review and submit through the official dashboard.

## Source map

- `auditor.html`, `src/security/main.js`, `src/security/style.css` — separate page and UI.
- `src/security/entropy-core.mjs`, `entropy-input.mjs`, `entropy-fixtures.mjs`, `entropy-worker.js` — entropy engine.
- `src/security/source-scanner.mjs` — static source triage.
- `src/security/program-data.mjs`, `program-workflow.mjs`, `storage.mjs` — program catalog and workflow.
- `src/security/report.mjs` — report rendering and evidence bundles.
- `scripts/security-audit.mjs` — executable CLI.
- `examples/security/` — intentionally weak and secure training fixtures.
- `test/security-*.test.mjs` — auditor regression tests.
