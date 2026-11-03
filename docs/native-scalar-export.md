# Fast native Ethereum scalar export

This is the high-throughput, streamed version of **All addresses + private keys within these bounds**. It enumerates every inclusive Ethereum private scalar in ascending order and writes exactly:

```text
EIP-55_address<TAB>0x-prefixed_32-byte_private_key<LF>
```

Every row is 110 bytes. There is no header and no application row cap. The mathematical bounds remain `1 <= start <= end < secp256k1_order`; host file-offset and available-storage limits still apply.

The native exporter is separate from address search, public-key BSGS, transaction recovery, puzzle scanning, and server file scans. It currently supports **Ethereum only**. The portable Node.js exporter remains available for every supported network. The bounded-generation button uses the native service for Ethereum once installed; other networks retain the slower in-memory browser path.

## Build

On Linux with a C compiler, `make`, Git, Node.js 22+, and npm:

```bash
cd /home/ssm-user/seedlab-src
npm ci --no-audit --no-fund
npm run export:scalars:native:setup
```

For a local checkout, use its own directory instead of `/home/ssm-user/seedlab-src`. On a minimal Ubuntu host, install the build prerequisites first with `sudo apt-get update && sudo apt-get install -y build-essential git`.

Setup clones `boulayo/bitcoin-puzzle-solver` at the exact pinned commit `f6b85a19411e61258ad6ecc5af7d20d521fdb7d7`, builds only its `pzcore` static library, compiles Seedlab's separate exporter, runs native self-tests, and installs:

```text
.runtime/bin/seedlab-eth-export
.runtime/bin/seedlab-eth-export.LICENSE.txt
.runtime/bin/seedlab-eth-export.NOTICE.txt
```

It does **not** start, stop, restart, or reconfigure any Seedlab service or puzzle campaign. It does not print or use the native-puzzle API token.

For a local UI development server, run `npm run server:scalar-export` in a separate terminal after building the binary. Vite proxies `/api/native-scalar-export/*` to that independent loopback service on port 8788.

## Use the bounded-generation button on EC2

Install the independent UI/API service from an updated clean checkout. With the EC2 layout used for this deployment:

```bash
cd /home/ssm-user/seedlab-export-src
git pull --ff-only origin main
sudo SEEDLAB_DOMAIN=api.seedlad.com \
  SEEDLAB_REPO=/home/ssm-user/seedlab-export-src \
  bash scripts/seedlab-ec2-scalar-export-setup.sh
sudo systemctl start seedlab-deploy.service
```

The deploy service builds the latest `origin/main` from its own source archive, so the older unrelated deployment checkout does not need to be reset or merged. The scalar installer:

- builds the pinned exporter under `/var/lib/seedlab-native/bin`;
- creates owner-only `/var/lib/seedlab-native/scalar-exports` storage;
- installs `seedlab-scalar-export-api.service` on **127.0.0.1:8788**;
- reuses `/etc/seedlab/native-api.env` without printing the bearer token;
- adds the authenticated `/api/native-scalar-export/*` Nginx proxy to the same HTTPS server blocks as the existing native controls;
- restarts **only** `seedlab-scalar-export-api.service` and reloads Nginx.

It does **not** restart `seedlab-native-api.service`, signal pzsolve, or restart a puzzle campaign. Port 8788 must remain loopback-only; do not add it to the EC2 security group.

Hard-refresh the deployed site. In **All addresses + private keys within these bounds**, enter the existing native API token, choose Ethereum and inclusive bounds, then click **Generate all addresses + private keys**. The button now starts native C generation instead of the old JavaScript loop. When complete, click **Download TXT** in a current Chromium browser on HTTPS: the authenticated response is piped directly to a file chosen with the browser's save-file picker. No bearer token appears in the URL and no whole-file Blob is created. Browsers without the File System Access API should use the CLI instead.

Only one UI export runs at a time. Completed files expire after 30 minutes; **Delete server copy** removes one sooner. API job metadata is memory-only, so restarting the scalar service invalidates old job IDs and its cleanup removes orphaned UUID-named files from the dedicated export directory. All status, start, stop, delete, and download endpoints require the bearer token. Nginx forwards the Authorization header and disables response buffering for downloads.

## Generate with the CLI

Example: exactly 1,000,000 inclusive rows using two workers:

```bash
npm run export:scalars:native -- \
  --start 1 \
  --end 1000000 \
  --threads 2 \
  --output exports/ethereum-1-1000000.txt
```

The output is owner-only (`0600`) where supported. Workers stream bounded batches with ordered `pwrite` offsets; memory does not grow with the total interval. One generator-point multiplication is needed per batch, followed by repeated Jacobian additions and one batch affine inversion. Keccak-256 and EIP-55 checksums are computed locally for every row.

- `--threads` accepts 1–32 and defaults to 2. More threads than available cores can be slower.
- `--chunk-size` accepts 1–65,536 rows and defaults to 4,096.
- `--network ethereum` is accepted for command-line consistency; other networks are rejected rather than silently using the wrong derivation.
- Existing final and `.partial` paths are never overwritten.
- On success, the binary flushes and closes the file, then publishes the final name with a no-replace hard-link operation.
- Ctrl+C/SIGINT or SIGTERM leaves an incomplete `.partial` file and no completed TXT. Move or delete that partial before retrying. There is no resume support.
- The pre-sized partial can be sparse and may have its final apparent size even while incomplete. Only the final non-`.partial` name denotes success.

**Storage:** budget 110 bytes per row before filesystem overhead. One million rows are 110,000,000 bytes; ten million are 1,100,000,000 bytes (approximately 1.1 GB). At 500,000 rows/sec, row data alone is 55,000,000 bytes/sec. Check free space on the actual output filesystem.

**Security:** the TXT contains every private key in the interval. Do not place it under Nginx/static hosting, commit it, or expose it through an unauthenticated download. `exports/` is Git-ignored. Small or published intervals are trivially searchable; never use their keys for real funds.

## Measure on the target host

The CLI reports measured wall-clock throughput including generation, writes, and final flush. Run a fresh output path; do not use an existing benchmark file:

```bash
npm run export:scalars:native -- \
  --start 1 \
  --end 1000000 \
  --threads 2 \
  --output /tmp/seedlab-ethereum-benchmark.txt
```

After inspecting the reported rate and file size, remove the known-test-key file:

```bash
rm -f /tmp/seedlab-ethereum-benchmark.txt
```

Measured in this development workspace (2 logical CPUs, Intel Xeon 2.60 GHz, Linux x86-64, ext4):

| Run | Workers | Rows | Bytes | Measured rate |
|---|---:|---:|---:|---:|
| Delivered npm command | 2 | 1,000,000 | 110,000,000 | **738,713 rows/sec** |

The output had exactly 1,000,000 lines and mode `0600`. Separate one- and two-worker short-run files were byte-identical. Sixteen rows from an earlier million-row high-scalar export, including batch boundaries and the inclusive end, were independently re-derived and matched. These are local measurements, **not a guaranteed EC2 rate**. CPU model, other load, filesystem, and storage latency matter. Do not stop or starve an active puzzle campaign merely to run a benchmark.

## Validate

After setup:

```bash
npm run test:export:native
```

The suite runs the native Keccak/key-1 self-test and checks license notices, exact EIP-55 rows against the independent Noble-based JavaScript implementation, parallel ordering, nonaligned batches, the highest valid scalar, invalid bounds, no-overwrite behavior, owner-only permissions, and SIGTERM cancellation. When the native binary has not been built, the native tests are explicitly skipped; the portable tests still run.

## Source and license notices

The exporter is a modified work based on `pzcore` from pzsolve by Leonardo Boulay, with a separate Seedlab Keccak/Ethereum/export driver. It is not the original pzsolve and is not endorsed by its upstream author.

- Pinned source: <https://github.com/boulayo/bitcoin-puzzle-solver/tree/f6b85a19411e61258ad6ecc5af7d20d521fdb7d7>
- Seedlab driver: `native/seedlab-eth-export.c`
- Keccak-256: `native/keccak256.h`
- Upstream AGPLv3+ license: `native/pzsolve-LICENSE.txt`
- Upstream additional notices: `native/pzsolve-NOTICE.txt`

Run `.runtime/bin/seedlab-eth-export --version` for the copyright, license, warranty disclaimer, modified-work notice, and source reference required by those notices. Keep the corresponding source and notice files available when conveying the binary.
