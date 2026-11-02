# Bitcoin puzzle kangaroo runs and key extraction — 2026-11-02

## Result summary

- Five real, bounded Pollard-kangaroo campaigns were started for **#140, #145, #150, #155 and #160** with their exact inclusive ranges and published public keys.
- The runner is **pzsolve 1.21.0**, commit `f6b85a19411e61258ad6ecc5af7d20d521fdb7d7`, from <https://github.com/boulayo/bitcoin-puzzle-solver>. It passed **623 CPU-only self-test checks**, including actual small-range kangaroo recovery and large-interval arithmetic.
- All 73 requested address-history checks completed. **72 active address-only puzzles have no revealing spend**. Historical **#256** has one revealing spend; its public key was extracted and locally validated.
- **No private key has been recovered.** A running probabilistic search is not a completed or likely recovery.

## Exact kangaroo targets

| Puzzle | Address | Inclusive lower bound (hex) | Inclusive upper bound (hex) | Published compressed public key |
|---|---|---|---|---|
| #140 | `1QKBaU6WAeycb3DbKbLBkX7vJiaS8r42Xo` | `0x80000000000000000000000000000000000` | `0xfffffffffffffffffffffffffffffffffff` | `031f6a332d3c5c4f2de2378c012f429cd109ba07d69690c6c701b6bb87860d6640` |
| #145 | `19GpszRNUej5yYqxXoLnbZWKew3KdVLkXg` | `0x1000000000000000000000000000000000000` | `0x1ffffffffffffffffffffffffffffffffffff` | `03afdda497369e219a2c1c369954a930e4d3740968e5e4352475bcffce3140dae5` |
| #150 | `1MUJSJYtGPVGkBCTqGspnxyHahpt5Te8jy` | `0x20000000000000000000000000000000000000` | `0x3fffffffffffffffffffffffffffffffffffff` | `03137807790ea7dc6e97901c2bc87411f45ed74a5629315c4e4b03a0a102250c49` |
| #155 | `1AoeP37TmHdFh8uN72fu9AqgtLrUwcv2wJ` | `0x400000000000000000000000000000000000000` | `0x7ffffffffffffffffffffffffffffffffffffff` | `035cd1854cae45391ca4ec428cc7e6c7d9984424b954209a8eea197b9e364c05f6` |
| #160 | `1NBC8uXJy1GiJ6drkiZa1WuKn51ps7EPTv` | `0x8000000000000000000000000000000000000000` | `0xffffffffffffffffffffffffffffffffffffffff` | `02e0a8b039282faf6fe0fd769cfbc4b6b4cf8758ba68220eac420e32b91ddfa673` |

The interval widths are respectively 2^139, 2^144, 2^149, 2^154 and 2^159 keys. These are not subranges, sequential scans, BSGS campaigns, or toy demonstrations.

## Running campaigns

Started on 2026-11-02 at approximately 15:05 UTC. Each process was launched with `--mode kangaroo --no-gpu --threads 1 --mem 0.25`, a 60-second checkpoint interval, and its own resumable campaign folder. The sandbox has two logical CPU threads on one physical core, 3.85 GiB RAM, and no CUDA or OpenCL GPU device.

The following is a **point-in-time snapshot**, not live progress. Live state is in `.runtime/pzsolve-campaigns/pN/status.json`; runtime data is intentionally excluded from Git.

| Puzzle | Campaign | State at snapshot | Steps done at snapshot | Observed Msteps/s | Found |
|---|---|---|---:|---:|---|
| #140 | `p140` | RUNNING | 688,926,720 | 11.812 | false |
| #145 | `p145` | RUNNING | 599,633,920 | 10.267 | false |
| #150 | `p150` | RUNNING | 684,240,896 | 11.677 | false |
| #155 | `p155` | RUNNING | 687,464,448 | 11.666 | false |
| #160 | `p160` | RUNNING | 685,162,496 | 11.148 | false |

The runner's expected mean work is approximately 8.85×10^20, 5.01×10^21, 2.83×10^22, 1.60×10^23 and 9.06×10^23 steps respectively. With all five sharing this CPU, initial provisional median estimates ranged from millions to billions of years. These searches are running because they were requested, not because recovery on this hardware is plausible soon.

### Resume in this workspace

From the repository root, after the runtime binary and campaign folders have been restored:

```sh
.runtime/bin/pzsolve hunt -p 140 --mode kangaroo --no-gpu --threads 1 --mem 0.25   --dir .runtime/pzsolve-campaigns --ui log --checkpoint-interval 60
```

Replace `140` with `145`, `150`, `155` or `160` for the other campaigns. Do not run a second process against a campaign that is already locked/running.

### AMD/OpenCL route on a suitable local machine

The same external runner documents OpenCL support for AMD GPUs. This route was **not tested on AMD here**, and upstream marks AMD kangaroo speed as untested. On the GPU machine, first verify the build and detected device:

```sh
git clone https://github.com/boulayo/bitcoin-puzzle-solver.git
cd bitcoin-puzzle-solver
make
./build/pzsolve devices
./build/pzsolve selftest
./build/pzsolve hunt -p 140 --mode kangaroo --gpu-api opencl --dir campaigns
```

Run the other puzzle numbers separately as desired. Do not substitute RCKangaroo's CUDA command on an AMD-only machine. Do not copy a live campaign folder while its process is writing checkpoints.

## Spending-history extraction

The 73-row input consists of 72 active unsolved puzzles without a published key plus historical puzzle #256. For every address, both `chain_stats.spent_txo_count` and `mempool_stats.spent_txo_count` were queried from mempool.space on 2026-11-02.

- **72 active puzzles:** both counts are zero. Their incoming funding, later deposits and dust do not reveal a public key. They remain address-only for this extraction method.
- **Historical #256:** one confirmed spend and no mempool spend. Its original funding output is transaction `08389f34c98c606322740c0be6a7125d9860bb8d5cb182c02f98461e5fa6cd15`, output 255. The revealing input is transaction `5d45587cfd1d5b0fb826805541da7d94c61fe432259e68ee26f4a04544384164`, input 95.

Extracted compressed public key:

```
029125aed5e5342de7c6163a4158a716ac982ba7d2ed85835c6ff99c68702ce710
```

Local validation parsed the secp256k1 point, computed HASH160 `9d77f8bcfd56b6a095703aae85bbe003a9cff5eb`, and derived exactly `1FMcotmnqqE5M2x9DDX3VfPAPuBWArGisa`. This is a public key only; no private scalar was recovered or exported.

The full 73-row result is in `bitcoin-puzzle-key-extraction-2026-11-02.tsv`. A zero-spend result is specific to spending history at that address and does not prove that a key was never published through some other channel.
