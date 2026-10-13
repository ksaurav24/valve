# Bounded Request replay validation

Issue [#43](https://github.com/ksaurav24/valve/issues/43) confirmed that cloning
streamed Request bodies can retain the complete upload in an unread branch.
The fix limits probing to 64 KiB and 1,024 chunks, cancels the discarded probe,
and sends oversized bodies once. Small bodies retain their retry behavior.

Compared baseline `400ef2c` with implementation `bd511e1` on Linux x64,
12th Gen Intel Core i5-12450H, 12 logical CPUs. Tests/builds did not compete
with benchmarks. [Raw evidence](footprint-results/issue43-validation.json)
retains every sample, including failed runs. These measurements are local
scheduler and parser workloads, not production HTTP throughput.

## Upload behavior and memory

A backpressure-aware source emitted 256 distinct 64 KiB chunks. A local server
drained and hashed each upload, returning 429 then 200. On Node 26.8.1 and
24.21.0, baseline sent two complete identical 16 MiB uploads; the fix sent one
complete upload and returned 429. The original Request remained unconsumed
on baseline and was consumed on the fixed oversized path.

Node 26's first-response forced-GC snapshot showed about 16.7 MB additional
array-buffer memory on baseline and no comparable retained buffer on the fix.
Node 24 snapshots did not distinguish the fixed wrapper from plain native
fetch: both retained about 16.9 MB with a 50ms settling delay. These are
GC-sensitive observations, not peak-memory measurements or proof of leaks.
Source backing storage and native fetch buffers remain outside Valve's limits.
Deterministic tests verify that discarded probe branches are closed. Removing
probe cancellation makes all three oversized/empty-chunk retention tests fail.

Run the reproduction from `packages/valve`:

```sh
pnpm exec node --expose-gc --import tsx bench/request-replay.mjs
VALVE_BENCH_NATIVE=1 VALVE_BENCH_SETTLE_MS=50 pnpm exec node --expose-gc --import tsx bench/request-replay.mjs
```

Set `VALVE_BENCH_LIBRARY` to an absolute baseline `src/index.ts` path for comparison.

## Performance and footprint

| Measurement                              |    Baseline |     Current | Result                              |
| ---------------------------------------- | ----------: | ----------: | ----------------------------------- |
| Node 26, 100k local jobs, median elapsed |   104.334ms |   108.033ms | +3.55%; elapsed gate passed         |
| Node 26, p99 start delay                 |     0.416ms |     1.435ms | Failed unchanged 1ms floor          |
| Node 24, 100k local jobs, median elapsed |   121.064ms |   110.592ms | -8.65%; elapsed gate passed         |
| Node 24, p99 start delay                 |     1.510ms |     1.489ms | Passed unchanged 15% gate           |
| Longer Redis/ioredis GCRA control        |   320.715ms |   358.957ms | -10.65% throughput; passed 15% gate |
| Longer Valkey/node-redis GCRA control    |   315.369ms |   334.479ms | -5.71% throughput; passed 15% gate  |
| Core minified + gzip                     | 8,590 bytes | 8,842 bytes | +252 bytes (+2.93%)                 |
| Core cold import median, Node 24         |     1.730ms |     1.812ms | +0.082ms; no startup gate           |

Each local run used three alternating cold-process pairs and retained all
samples. The first broad shared-store run failed Redis/ioredis GCRA (-27.29%);
the second failed Valkey/node-redis GCRA (-17.23%). Each used three alternating
pairs, ten rounds after warmup, 50k local jobs and 20k shared jobs. Other cases
stayed within the gate in each run. Pooling both broad runs leaves Redis GCRA
near the boundary (-15.07%); the shorter measurements do not establish absence
of regressions.

The longer diagnostic retained the same three-pair, ten-round protocol and
15% threshold, with 100k shared jobs in the two flagged cases. Both passed.
Timing varied across runs; this does not establish a speed improvement or
remove the failed shorter results. The benchmark workloads never call wrapFetch.

The finite replay code exceeds the old 8,704-byte absolute core ceiling.
Raising it by 256 bytes to 8,960 preserves roughly the previous headroom.
Redis and headers entry sizes and ceilings are unchanged. Runtime performance
thresholds are unchanged. Raw startup evidence contains 30 fresh processes
per variant per entry; its small differences are not general startup claims.

Reproduce the normal gates from the repository root:

```sh
node scripts/paired-benchmarks.mjs /tmp/valve-43-baseline/packages/valve/src/index.ts /tmp/base.json /tmp/current.json
node scripts/compare-benchmarks.mjs /tmp/base.json /tmp/current.json
REDIS_URL=redis://127.0.0.1:16443 VALKEY_URL=redis://127.0.0.1:16444 node scripts/paired-footprint-controls.mjs /tmp/valve-43-baseline /tmp/controls
```

Create the baseline worktree at `400ef2c`, install its locked dependencies,
and build both libraries before footprint/startup comparisons. Use the same
Node version for both variants, run without concurrent builds/tests, and
retain failures as well as successful measurements.
