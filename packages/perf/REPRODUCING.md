# Reproduce a performance run

This how-to reproduces harness evidence without treating results from unlike machines as
comparable. Commands run from the repository root.

## Prerequisites

- Node 24 and pnpm 11.28.4;
- a clean checkout with the exact commit and lockfile recorded in the run manifest;
- Docker for Redis/Valkey tiers;
- Linux with delegated cgroup v2 and CPU isolation for authoritative performance evidence.

## Reproduce portable checks

```sh
pnpm install --frozen-lockfile
pnpm --filter valvejs build
pnpm --filter @valve/perf test
pnpm --filter @valve/perf typecheck
pnpm perf quick
```

These checks establish unit/model behavior on the current machine. They do not reproduce an
authoritative timing claim.

## Reproduce real-store smoke

Use harness-owned disposable containers. The label, recorded token, and live sentinel jointly
guard every database flush.

```sh
pnpm perf infra up redis74
pnpm perf infra up valkey8
pnpm perf infra status
pnpm perf smoke --stores redis74,valkey8
pnpm perf infra down redis74
pnpm perf infra down valkey8
```

If Docker is unavailable, a user-supplied URL remains in prefix mode. To adopt a dedicated
endpoint for disposable use, first prove it contains no data:

```sh
pnpm perf infra adopt redis://127.0.0.1:6379 --empty-only
```

Adoption refuses a non-empty database. Never adopt a production or shared endpoint.

## Reproduce a paired comparison

First inspect the host and print the exact plan:

```sh
pnpm perf doctor
pnpm perf calibrate
pnpm perf plan --profile targeted --suite gcra
```

Then compare immutable build identities in cold, paired trials:

```sh
pnpm perf matrix --profile targeted --suite gcra --base <base-ref> --head <candidate-ref>
```

Use `--current` instead of `--head` to include the current checkout. If the estimate exceeds 60
minutes, review the plan and add `--yes`. Do not compare result summaries whose manifests have
different environment, build, suite, cell, plan, margin, or seed hashes.

## Verify the C1 deadline fix

With registered disposable Redis 7.4 and Valkey 8 stores:

```sh
pnpm perf c1 --stores memory,redis74,valkey8
```

On valvejs 0.5.2 or later, expect `PASS - DEADLINE REGRESSION CHECK` and exit 0: the blocking
job finished, the following job's deadline elapsed, and that job rejected with
`MAX_WAIT_EXCEEDED` without invoking its callback. A late callback is safety FAIL and exits 1.
An unrelated rejection or ineffective probe remains UNVERIFIED and exits 2.

Historical pre-fix runs retain their original FAIL status. Re-rendering evidence without a
verified rejection never upgrades it to PASS. Compare new builds in new run directories;
immutable old manifests and raw evidence remain intact.

## Render and archive evidence

Each run is immutable under `.perf/runs/<runId>/`. Render its reports with:

```sh
pnpm perf report <runId> --html
```

Archive the complete run directory, not only the HTML summary. The directory contains the
manifest and hashes, raw trial records, environment fingerprint, safety findings, analysis, and
machine-readable JSON/CSV needed to audit or re-render the result. CI uploads the same run
directory even after failures.

Before citing a result, record:

- run ID and source commit;
- manifest and environment fingerprint hashes;
- base and candidate build identities, including patch hashes;
- server image names/digests and whether the run is authoritative;
- safety status separately from every performance verdict;
- skipped, censored, retried, resource-invalid, and generator-saturated trials.

The pre-harness evidence is preserved separately at
`/home/xlr8/valve-evidence-archive/2026-10-19-pre-harness/`. That machine-local archive contains
`bench.tar.zst`, a 6,906-file SHA-256 manifest, and the archive-time git status. It was fully
extracted and hash-verified, then made read-only. It is provenance for legacy golden comparisons,
not a substitute for a new run's `.perf/runs/<runId>/` evidence.

## Short verification commands

```sh
PERF_INTEGRATION=1 pnpm --filter @valve/perf test:integration
pnpm perf smoke --suite gcra,fixed-window,multi-rule,scoped,weighted,lease,combined,api --stores memory,redis74,valkey8 --html
pnpm perf matrix --base HEAD --current --suite gcra --cell sat-1w-100-b1 --reps 1 --window 1s --warmup-ms 0 --drain-ms 100 --html
pnpm perf libs --category L1,L2,L3,L4,L5,D1,D2,D3 --reps 1 --html
pnpm perf soak --suite lease --duration 8s --rate 10 --warmup-ms 0 --drain-ms 200 --html
pnpm perf chaos --faults redis-pause --workers 2 --window 2s --warmup-ms 0 --drain-ms 200 --html
```

Matrix samples with one replication are descriptive. Increase to a preregistered 5/10/20 design
only after reviewing the plan. Full durations and distributed performance comparisons require a
dedicated host; the implementation record never substitutes a sample for those measurements.

Library runs keep the uniform 100 ms L1/L1-noop defaults to bound deep-backlog recording.
Other categories use longer windows. One-rep library runs verify wiring and contracts, not
performance differences. Exact competitor reservation clocks remain `UNVERIFIED`; callback
envelopes, actual concurrency, and queued cancellation are checked separately. L5 cancels only
jobs that are still queued, so differences in running-job cancellation do not enter that category.

Server locks live in `.perf/locks/` and record their owner's PID and run ID. An interrupted
supervisor can leave a stale lock. Inspect the PID and retained evidence before removing that
specific lock; do not clear locks belonging to running processes. Prefix-mode URLs permit
ordinary isolated trials, while faults require a recorded, sentinel-verified disposable endpoint.
