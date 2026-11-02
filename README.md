# Seedlab — an interactive wallet primer

A browser-based, step-by-step crypto wallet learning demo. It generates BIP-39 entropy and a 12-word phrase, derives the 512-bit seed and BIP-32 keys, then shows address-construction traces for Ethereum, Bitcoin, TRON, and BNB profiles. Derivations and the bounded address search run locally in the browser; bounded searches use a capped Web Worker pool.

## Run locally

```sh
npm ci
npm run dev
```

Open the URL Vite prints (localhost is a secure context for browser cryptography). Build with `npm run build`.

## Address profiles

| Profile | Derivation path | Address construction |
| --- | --- | --- |
| Ethereum | `m/44'/60'/0'/0/0` | secp256k1, legacy Keccak-256, last 20 bytes, EIP-55 |
| BNB Smart Chain | `m/44'/60'/0'/0/0` | Same EVM format and address as Ethereum for the same key; select the chain separately when using a wallet |
| Bitcoin Legacy P2PKH | `m/44'/0'/0'/0/0` | HASH160 of compressed key, Base58Check version `00` |
| Bitcoin Nested SegWit P2SH-P2WPKH | `m/49'/0'/0'/0/0` | P2WPKH redeem script, HASH160, Base58Check version `05` |
| Bitcoin Native SegWit P2WPKH | `m/84'/0'/0'/0/0` | HASH160 of compressed key, Bech32 witness v0 (`bc1q…`) |
| Bitcoin Taproot P2TR (BIP-86) | `m/86'/0'/0'/0/0` | BIP-86 internal key, BIP-341 `TapTweak`, Bech32m witness v1 (`bc1p…`) |
| TRON mainnet | `m/44'/195'/0'/0/0` | Keccak-256 of the public-key body, version `41`, double-SHA-256 Base58Check |
| BNB Beacon Chain (legacy BEP2) | `m/44'/714'/0'/0/0` | HASH160 of compressed key, Bech32 HRP `bnb`; distinct from BNB Smart Chain |

These are representative first-address profiles. Network selection does not connect to a chain or check balances. The Beacon profile is for historical/reference derivation; do not confuse it with BNB Smart Chain.

### Reproducible public test vector

For the public BIP-39 test mnemonic `abandon` repeated 11 times followed by `about`, with an empty passphrase and the paths above, the Bitcoin address outputs are:

- BIP-44 Legacy: `1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA`
- BIP-49 Nested SegWit: `37VucYSaXLCAsxYyAPfbSi9eh4iEcbShgf`
- BIP-84 Native SegWit: `bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu`
- BIP-86 Taproot: `bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr`
- BNB Beacon Chain profile at coin type 714: `bnb1rxhz5vdv4fvdjye8gxqvfv0yvg20jtlwf4f38d`

This is a publicly known test mnemonic only. Never use it or any sample phrase to hold funds.

## Bounded address search

For EVM profiles, the input also accepts a validated 33-byte compressed or 64/65-byte uncompressed secp256k1 public key and calculates its address directly, without searching. For addresses, choose inclusive decimal scalar bounds from 1 to the secp256k1 curve order minus one (slightly below 2²⁵⁶); the default is 1–10,000. The local worker pool partitions the interval without gaps, uses at most eight workers (and no more workers than candidates), stops at the first match, and reports progress and a measured rate. The Stop control cancels at chunk boundaries. Every network profile has a **Choose batch TXT** option: upload up to 10,000 address entries in a file of at most 5 MB, one per line or separated by spaces, commas, semicolons, or tabs. Each entry is validated for the selected network, duplicates are removed, and each candidate is compared with all targets in one pass. Ethereum files may additionally contain `address,tx_hash` rows for public-key extraction; other networks accept addresses only. Public keys pasted into an address batch are rejected rather than silently searched as addresses. Files and candidate searches stay in the browser. Both searches allow editing the bounds during a run; edits apply to the next run, not the active one.

The same inclusive bounds can enumerate every scalar in an interval of up to 10,000 values: click **Generate all addresses + private keys**, watch the local progress, then click **Download TXT**. The app derives the selected network’s address and exports the corresponding 32-byte private key for every scalar in ascending order. The headerless TXT contains only `address<TAB>0x…64_hex_character_private_key` on each line—no public keys, decimal scalars, bounds, labels, or other metadata. Nothing is uploaded or persisted automatically. **The downloaded file is sensitive: anyone with it can control the addresses.** Small or known intervals are trivial to search, so their keys must not hold real funds.

To export public keys from signed Ethereum transactions, upload a `.txt`/`.csv` file with one `address,tx_hash` pair per line (a header row is optional). After upload, choose an Ethereum JSON-RPC endpoint and click **Extract public keys and download TXT**. This looks up each transaction, requires the listed address to be the transaction sender, recovers the uncompressed signer public key, and verifies the recovered address before export. The selected RPC provider receives the public transaction hashes; no private keys are requested or generated by this feature. Transactions to an account do not reveal that account’s key; use an outgoing transaction from the account.

Workers partition the range and update each public point incrementally (`Q_(d+1) = Q_d + G`) instead of recomputing `dG` from scratch for every candidate. They batch-normalize each chunk of points to reduce expensive field inversions and compare address payload bytes directly, avoiding per-candidate address-string encoding. The measured rate and a device-specific remaining-time estimate are shown during the run. A large run, especially 10²¹ candidates, is not practically completable on browser hardware and would consume substantial device CPU; use the live rate estimate and Stop control. The range is educational, not a realistic key-recovery workload. The Stop control cancels at worker-chunk boundaries.

This is not practical recovery for a randomly generated real wallet: 10²¹ is about `2^70` scalars, while secp256k1 has nearly `2^256` possible private scalars. A miss rules out only the tested interval. Keep this as a browser-side educational/test-range tool. A server-side EC2 search would require a compute API, expose the instance to abuse and unexpected CPU charges, and disclose the searched address to that server; it is not recommended for the public static site.

## Uploaded Ethereum or Bitcoin public-key search

Use **Choose batch TXT** and **Run batch public-key search** to load the tab-separated `.txt` export produced by the public-key extraction feature. The file has `address`, `transaction_hash`, `public_key_uncompressed`, and `status` columns. The browser validates every row, including the secp256k1 point and its Ethereum or supported Bitcoin address, before starting; malformed, failed, or mismatched rows cause an error rather than being silently skipped. The transaction hash is checked for format only, not re-fetched or independently verified. A key loaded from the built-in puzzle catalog uses the explicit `published-catalog` source marker instead of claiming a transaction hash. Files (up to 5 MB and 10,000 rows) remain local and are not saved or uploaded.

A validation worker checks the file, then CPU search workers split targets into disjoint groups. Auto uses up to eight workers based on reported logical cores; the CPU worker selector can request 1–32, limited by the number of targets. Each search worker uses its own baby-step giant-step table shared across its group; more workers use more CPU and memory and do not guarantee a speedup. The optional experimental WebGPU modes dispatch the BSGS collision-table lookups to a GPU. Hybrid mode divides targets between CPU-only workers and up to two GPU-assisted workers (at least two workers and two public keys are required); it stops on any worker error instead of silently falling back. In both modes, elliptic-curve point math and independent verification of every lookup remain on the CPU. GPU lookup groups are batched (up to 1,024 keys per dispatch) and query buffers are reused to reduce dispatch and allocation overhead. Every lookup is independently checked on CPU to avoid silently missing a collision if a GPU result is wrong; this duplicate checking can make WebGPU slower than CPU-only. WebGPU requires a supported browser and secure context. If WebGPU is exposed on the browser window but not in a worker, GPU lookup batches are bridged through the window. If neither context has a usable GPU, or if lookup verification fails, the search stops with an error rather than claiming a complete result; the UI offers an explicit CPU-only retry. Bridging adds transfer overhead. High-performance and low-power are adapter preferences, not guarantees of a discrete or integrated GPU. WebGPU mode is limited to two workers to limit device resource use. The default inclusive decimal interval is 1–1,000,000 and bounds may span the valid secp256k1 private scalar range, from 1 to curve order minus one (slightly below 2²⁵⁶). Each worker processes larger ranges sequentially in chunks of at most 100,000,000 scalars; this bounds per-chunk memory but sacrifices the square-root scaling of a single BSGS search over the whole interval. The full range is completely infeasible, and a large run may not complete within a human lifetime. To continue after a completed 1–1,000,000 search, set the next lower bound to 1,000,001. Each collision is verified by recomputing `dG`, and the result includes the decimal scalar and compressed collision point (or point at infinity). A recovered scalar is private-key material: do not share it. Stop returns partial progress and any already verified matches. Giant-step slots are not the same as address candidates per second and include slots for targets already matched. To improve throughput, the worker uses affine-coordinate lookup keys, throttles progress updates, and yields periodically for cancellation; actual throughput depends on the device and browser and is not guaranteed. Only a completed run can exclude matches in the whole selected interval. A random real wallet key is overwhelmingly unlikely to fall in this arbitrarily chosen interval; neither BSGS nor kangaroo makes a full keyspace search feasible.

## Real puzzle campaign status

The Exchange Lab page includes a **Campaign status** panel for the five real bounded pzsolve campaigns (#140, #145, #150, #155 and #160). It reads live workspace `status.json` and lock-PID data through `/api/puzzle-campaigns`, refreshes every second, and shows process activity separately from actual expected-work progress. A static deployment cannot read local campaign files; use the workspace UI server for live status. See `docs/puzzle-campaign-monitor.md` for the runtime layout and resume command. The former synthetic kangaroo demo has been removed.

## Server-side wallet scan (upload → EC2/Lambda)

The app now has an **upload panel**: drop a file of wallet secrets (seeds, BIP-39 mnemonics, or hex private keys), one per line in `.txt`/`.csv`, or a JSON array. The file is uploaded and a server job derives each input's addresses for **every** supported network (Ethereum, BNB Smart Chain, BTC Legacy/Nested/Native-SegWit/Taproot, TRON, BNB Beacon) and validates them. The UI polls for live progress and shows a results table.

- Local/dev: the bundled Node server (`npm run server`) accepts the upload and scans in-process. Vite dev proxies `/api` to it.
- Production: the scan runs serverless — the file goes to S3, a Lambda derives the wallets, job state lives in DynamoDB, and the UI polls the API Gateway endpoint. See [`infra/`](infra/) (Terraform) and [`docs/serverless-scan.md`](docs/serverless-scan.md).

Run the local stack:

```sh
npm run build && npm run server   # serves dist/ + /api on :8787
# or, for live reload with API proxy:
npm run dev                       # Vite on :5173 proxies /api -> :8787 (run server separately)
```

Build/deploy the Lambda:

```sh
cd server && ./build-lambda.sh    # -> ../infra/seedlab-scan.zip
cd ../infra && terraform init && terraform apply
# set VITE_SCAN_API_BASE to the printed api_url, then:
npm run build
```

## Safety

The local derivation lab keeps secret values in this browser; they are not sent anywhere. The **upload panel intentionally sends your file to the server** for scanning. Uploads are not retained permanently (the Lambda/S3 setup encrypts them and auto-expires them), but you should still **only upload test data, never real wallet secrets**. Clipboard actions expose values to the clipboard.

The public demo is HTTP-only unless separately configured for HTTPS. Never enter or upload real wallet secrets until HTTPS and a trusted, reviewed build are established. This educational demo is not audited and must not be used to create or hold a wallet for real funds.

## Deploy

The repository includes `vercel.json` and can be imported as a Vite project on Vercel (build command `npm run build`, output directory `dist`). It can also be deployed as a static site on Render with the same build command and `dist` publish directory.

For private EC2 hosting, see [the EC2 deployment guide](docs/ec2-deployment.md). Keep SSH/port 22 closed; serve only the static site publicly. The guide describes the configured deployment workflow and Systems Manager setup. The server-side scan API is a separate, serverless component — see [`docs/serverless-scan.md`](docs/serverless-scan.md).

### GPU lookup benchmark

In **Public-key Search**, use **Run GPU benchmark** to test the WebGPU collision-table lookup path on synthetic points. Choose a power preference before starting; browsers may ignore it or hide adapter details. The result reports the selected adapter information exposed by the browser, whether GPU work ran in the worker or via the window bridge, and verified lookups per second. Copy the report to share it manually. No uploaded keys are used or sent.

The benchmark warms up first, then measures 48 batches of 1,024 lookups (half hits, half misses), including lookup upload, dispatch, readback and CPU verification, but excluding adapter setup, table creation and warm-up. It is **not** end-to-end public-key search throughput, elliptic-curve performance, GPU utilization, or address candidates per second. The benchmark and public-key search cannot be started together. It requires WebGPU in a secure context (HTTPS or localhost); the bridge cannot make WebGPU available when the window does not support it.

### Planning a public-key search range

The range planner shows the inclusive scalar count, number of internal chunks, uniform-key coverage probability and planned giant-step slots for a chosen target count. Optionally enter a measured **search** slots-per-second rate for a rough slot-only time estimate; it excludes setup and depends on the rate holding, and the GPU lookup benchmark rate is not interchangeable with it. The target count is an estimate you supply, not a validation of the uploaded file.

If you have independent evidence of an exact private-scalar bit length, the planner can apply its inclusive bounds (capped at the secp256k1 order minus one). This is a conditional range, not something inferred from a public key. Edits during a search affect the next run, not the current one. Uniformly generated keys have no favored region, and searching the full range remains infeasible.

### Search workspace and public-key extraction

The search workspace groups the existing address-search network/address-format selector, single-key extraction, bounded address search, public-key BSGS and puzzle guidance. All listed network profiles use secp256k1, but address encodings differ; USDT follows the network on which it is issued. Changing the network here also changes the wallet lab network. Search methods remain different: address search derives candidate addresses; BSGS requires a known public point and an inclusive scalar interval.

**Find public key** accepts either an Ethereum address and outgoing transaction hash, or a Bitcoin address. Ethereum sends the transaction hash to the selected HTTPS JSON-RPC provider and checks that the recovered signer matches the address. Bitcoin sends the address to the public mempool.space API and examines up to five history pages for a supported spending input. It supports P2PKH (compressed or uncompressed key), P2WPKH, and P2SH-P2WPKH; the revealed point is checked against the address and previous-output script. Taproot, P2WSH, other P2SH scripts, and arbitrary scripts are not supported. An incoming payment does not reveal the receiver's public key. A missing key is not proof that none exists, especially when the page limit is reached; provider availability, rate limiting, browser CORS and incomplete or inaccurate provider data can affect results. The checks validate key/address commitments but trust the provider's transaction and previous-output data, rather than independently proving blockchain inclusion. This does not recover a private key. Use only public data and authorized targets.

A successfully extracted single key can be copied or loaded directly into the public-key BSGS search without a file download. The recovery panel also has **Choose batch TXT** for both networks. Ethereum accepts one `address,transaction_hash` pair per row; Bitcoin accepts one supported address per row. Recovery batches allow up to 1,000 unique rows and 5 MB, process at most four Ethereum or two Bitcoin requests concurrently, and report each row independently. Stop prevents new rows from starting and waits for in-flight requests; unprocessed rows are marked cancelled. The completed results can be downloaded or copied as TXT, including provider errors, and only successful rows are loaded when sending the batch to BSGS. A full result file containing failed rows is not a valid BSGS input; use the direct successful-rows option. Public-key TSV validation accepts supported Bitcoin addresses and checks their commitment to the public key. Files remain local during search, but clicking recovery sends the public addresses or transaction hashes to the selected provider. Automated tests use parser fixtures and mocked provider behavior; live provider availability and browser CORS are not guaranteed.

### Published Bitcoin Puzzle catalog

The puzzle panel contains all 160 active entries in the well-known Bitcoin Puzzle series, using the row data from [`roadhero/Bitcoin-Puzzle-info`](https://github.com/roadhero/Bitcoin-Puzzle-Info/blob/6bbd33dcefe2b4d039f96f437e86ea5f918de495/BTC-Solved-Unsolved.txt), commit `6bbd33dcefe2b4d039f96f437e86ea5f918de495` dated 2026-07-31 and retrieved 2026-11-02. The snapshot has 83 rows marked solved and 77 marked unsolved; its source README summary is older than those rows. This is one published series, not a claim to cover every cryptocurrency puzzle, and the labels are not live status, funding, or balance checks.

Every puzzle #N has inclusive bounds `2^(N−1)` through `2^N−1`. The UI can filter the catalog, copy a public record, copy or download the complete public TSV, and apply one entry's Legacy P2PKH address and exact decimal bounds to address search. Applying never starts a run. All 160 addresses and published points are validated locally; the published solved scalars were checked during catalog preparation and then omitted from the app data. The snapshot has 88 published public keys overall, including five entries marked unsolved (#140, #145, #150, #155 and #160). When available, a published point can be loaded into BSGS with its bounds; an address-only entry cannot.

The catalog does not enumerate or export candidate private keys and does not scan unrelated wallets for balances. If a bounded search finds a scalar for a recognized catalog address, the results list it and offer download and clipboard export. Export independently requires the scalar to be inside the published bounds, recomputes `scalar × G`, checks it against the supplied public point, and verifies the compressed P2PKH address before including the decimal scalar and 32-byte hexadecimal private key. It explicitly reports that no balance was checked. Large published ranges remain computationally infeasible even though they are narrower than the full secp256k1 range.
