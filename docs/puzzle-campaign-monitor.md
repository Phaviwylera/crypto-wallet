# Local kangaroo campaign monitor

`scripts/puzzle-status-server.mjs` serves a local dashboard for the five bounded pzsolve campaigns: **#140, #145, #150, #155 and #160**.

## Open the monitor

From the repository root:

```sh
PORT=4174 node scripts/puzzle-status-server.mjs
```

The server binds to `0.0.0.0`. In Arena, use the Live Preview associated with port **4174**. On a local machine outside Arena, open `http://localhost:4174`.

The dashboard refreshes `/api/status` every second. It has no external browser dependencies and makes no blockchain or remote API requests.

## What the bars mean

- **Striped activity bar:** the campaign lock contains a live process ID and the status is `RUNNING`. It is not a completion measurement.
- **Blue expected-work bar:** `done / total`, where `total` is pzsolve's expected mean kangaroo work. The current ratios are so small that the solid bar may be invisible; the adjacent scientific-notation percentage remains exact to JavaScript number precision.
- **Stopped:** a status file says `RUNNING` but its lock PID is no longer alive. This prevents a stale file from being presented as an active search.

The page shows steps completed, current rate, elapsed worker time, expected mean work, and the runner's median estimate. It does not read `FOUND.txt`, private scalars, or worker result files.

## Workspace data

The monitor reads only these known campaign locations:

```text
.runtime/pzsolve-campaigns/p140/status.json
.runtime/pzsolve-campaigns/p145/status.json
.runtime/pzsolve-campaigns/p150/status.json
.runtime/pzsolve-campaigns/p155/status.json
.runtime/pzsolve-campaigns/p160/status.json
```

It also reads each campaign's `lock` file for liveness. Runtime state is excluded from Git. If the workspace or `.runtime` directory is replaced, the monitor reports `NOT_STARTED`; restoring a prior Git commit does not restore campaign progress.

## Resume a campaign

Only resume when no process already holds that campaign's lock:

```sh
.runtime/bin/pzsolve hunt -p 140 --mode kangaroo --no-gpu --threads 1 --mem 0.25 \
  --dir .runtime/pzsolve-campaigns --ui log --report-interval 1 --checkpoint-interval 60
```

Replace `140` with `145`, `150`, `155` or `160` as needed. Starting a missing campaign creates new state; it does not recover progress from the earlier sandbox.

See `reports/bitcoin-puzzle-operations-2026-11-02.md` for the pinned runner source, exact target ranges, build instructions, and extraction report.

## Validate

```sh
node --test test/puzzle-status-server.test.mjs
```

The tests cover live and stale PID handling, all five API entries, found-state privacy, inline script syntax, HEAD requests, missing routes, and unsupported methods.
