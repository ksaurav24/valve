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

## Run the Sylvie preset

Close other heavy workloads, stay plugged in, and use Node 24. Inspect the plan, then run:

```sh
pnpm perf plan --profile sylvie
pnpm perf:sylvie
```

The default baseline is the exact `HEAD` commit and the candidate is the current checkout.
To select another baseline, pass `--base <ref>`; use `--head HEAD` to compare identical builds
when checking measurement repeatability. The wrapper uses the existing build snapshots,
manifests, raw records, safety oracles, and statistics.

The default plan has two workloads: GCRA 500/s burst 1 and global leases with concurrency 8
and mean 20 ms async jobs. Both use two worker processes. It runs ten fixed paired repetitions
with separate base/A-A/head trials, 15-second measurement windows, two-second warmups,
500 ms drains, and one correctness audit per workload: 62 trials, about 21 minutes on the
calibrated i5-12450H. For a shorter focused study, `pnpm perf:sylvie --suite gcra` retains the
same repetitions and window length while running only the rate workload.

CPU placement selects one logical thread from each of three physical cores in the fastest
core class. On this laptop it uses workers 2/4 and server 6, avoiding SMT siblings and efficiency
cores. Linux CPU topology, cgroup controls, and Docker are required; missing controls fail
before measurements. The process scope has a 3 GiB memory cap and no swap. Its resource guard
limits measured process memory to 2 GiB, requires 4 GiB available before each trial and 2 GiB
during execution, and retains the existing CPU, swap, and memory-pressure rejection rules.

Redis 7.4 is provisioned automatically if not registered, with the chosen CPU pinning, and
removed in cleanup. A matching registered store is reused and left registered. Existing stores
with different CPU placement, active endpoint locks, and containers outside this checkout's
registry are refused. `--stores valkey8` selects a single Valkey store instead. Other existing
containers and host power settings are not changed.

HTML and machine-readable reports are retained in the normal run directory. Statistical
margins are unchanged, and unstable A/A still withholds candidate conclusions. This preset
covers focused rate and lease comparisons; run smoke for broader correctness coverage and
targeted/decision profiles for larger fleets. Explicit timing or replication overrides create
a different plan and can reduce evidential strength.

The first full laptop validation completed all 62 trials without resource retries, but rate
utilization and lease fairness still failed the A/A precision gate. To plan a larger fixed study,
use `pnpm perf:sylvie --reps 20 --dry-run` (about 42 minutes on this calibration), then start a
new run with the chosen replication count. More data can improve precision; it does not
guarantee equivalent A/A. Never widen margins or discard valid trials to force a verdict.

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

Distributed Valve library cells also run one instrumented correctness trial, reported as
`valve-audit`. Those audit timings never enter library or A/A comparisons. A passing audit
establishes safety for that separate trial; uninstrumented performance rows retain their own
UNVERIFIED rate/window status. Proving exact competitor reservation semantics requires their
internal decision traces; increasing callback timing tolerances cannot supply that evidence.

For planned restart correctness trials, the harness atomically snapshots the Lua log and pauses
writes, saves the snapshot outside the container, then restarts without persistence. Reports
check each store generation separately. A failed checkpoint or expired pause cannot justify
PASS. This covers a planned restart with an audit barrier, not an unannounced crash. Use a
longer window to observe recovery:

```sh
pnpm perf chaos --faults redis-restart --stores valkey8 --workers 2 --window 10s --warmup-ms 0 --drain-ms 500 --html
```

If A/A remains unstable, choose a new run directory and preregister longer windows and more
replications before execution. Keep the margins unchanged. Pin the server and workers to
separate physical cores, protect the process scope, and avoid concurrent workloads. For
example, after verifying this machine's topology, CPUs 6 and 4 can be assigned separately:

```sh
pnpm perf infra up redis74 --cpuset 6
pnpm perf matrix --profile targeted --suite gcra --cell sat-1w-100-b1 --base HEAD --head HEAD --reps 10 --window 10s --warmup-ms 500 --drain-ms 200 --stores redis74 --worker-cpus 4 --isolate --require-authoritative --html
```

`infra up` reuses existing containers; use a newly created container or explicitly recreate a
harness-owned one if its CPU assignment differs. Identical base/head refs test repeatability,
not an optimization. Single-worker cells exclude the inapplicable Jain fairness metric before
execution. Isolation and more data can improve precision, but do not guarantee equivalent A/A.

Server locks live in `.perf/locks/` and record their owner's PID and run ID. An interrupted
supervisor can leave a stale lock. Inspect the PID and retained evidence before removing that
specific lock; do not clear locks belonging to running processes. Prefix-mode URLs permit
ordinary isolated trials, while faults require a recorded, sentinel-verified disposable endpoint.
