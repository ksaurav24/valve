# Paced scheduling drift

Issue #11 builds on merged PR #10, commit
`360621096a5b9a05b2886a17748d539cd6436cf5`. The original 5ms p99
ideal-sequence target remains open. This work does not change the rate algorithms,
the memory store clock, Redis/Valkey clock authority, or public timestamps.

## Reproduced cause and change

The scheduler previously waited the full returned retry delay after an
asynchronous acquisition resolved. A store admitting at 0ms and returning its
10ms retry delay at 5ms therefore caused the next request at 15ms. A deterministic
regression records callback starts at 5, 20, and 35ms. Accounting for elapsed
acquisition time moves those callbacks to 5, 15, and 25ms.

Only asynchronous acquisitions with local concurrency use the adjustment.
The synchronous memory path and global concurrency waits retain their scheduling.
The scheduler captures `performance.now()` before the request and subtracts the
elapsed duration when it arms the next check. Public deadlines and timestamps
remain epoch-based. Forward and backward client wall-clock changes during a
request do not change this elapsed duration.

This is an estimate of an earliest useful check, not a grant. The elapsed duration
includes outbound request time, which precedes the store's eligibility calculation.
An unexpectedly long outbound leg can produce an early retry and an additional
denial. Every request still passes through atomic admission; tests cover changing
outbound latency and responses arriving after eligibility without catch-up grants.
Pause responses and outage retries do not use this adjustment.

## Measurement protocol

`drift.mjs` builds baseline and current sources before timing. Instrumentation is
inserted into temporary bundles and never shipped. Each measured sample runs in
an isolated process with a 32-job warmup in that same process. Each pair alternates
baseline/current order across three repetitions. The workloads queue 200 and
2,000 synchronous no-op callbacks at 100/sec, with either the synchronous memory
store or an asynchronous wrapper that adds a requested 5ms response delay.
The latter isolates response delivery; it is not a network emulator.

Trace records separate the memory store's evaluation time and next eligibility
(`now + retryAfterMs`), armed wall deadline and requested timeout, actual wakeup,
store grant, and callback dispatch. Store evaluation uses `Date.now()`; event
times, waits, service, and sequence delay use `performance.now()`. Timer delivery
overshoot is actual elapsed time since arming minus requested timeout. Small
negative values can occur because Node's timer resolution and these clock reads
are not identical. A grant trace is recorded after the synchronous store's
bookkeeping, with its original evaluation timestamp retained.

Each sample retains throughput, p50/p99 queue wait and service time, spacing
overshoot, ideal-sequence delay, CPU, GC counts/duration, process peak RSS,
end-of-run heap usage, event-loop delay, and acquisition counts. End heap usage
is not peak heap, and GC events do not measure allocated bytes. Peak RSS includes
module loading and warmup. The 1ms event-loop monitor and trace allocation affect
the workload; paired comparisons share that instrumentation.
CPU includes the event-loop monitor and harness. A lower CPU total can reflect
a shorter measured run, rather than lower work per acquisition. No general CPU
or allocation improvement is claimed.

## Paired results

Measured on 2026-10-08, on a 12th Gen Intel Core i5-12450H with 12 logical
CPUs, Linux 7.2.8-arch1-2, and esbuild 0.28.2. All runtimes ran sequentially
on the same host. The current runtime source is commit
`46a0c822bf084155f825b87b66bd3a288e4db9c9`; the raw reports retain the harness
hash, options, source revision, and every sample. This is a workstation measurement,
not a calibrated dedicated runner or a production HTTP throughput result.

Each table value is the median of three per-round values; acquisition counts
are the mean per job. Percentiles are per-round percentiles, not pooled samples.

### Asynchronous store with 5ms response delivery

| Node    | Jobs | Baseline jobs/sec | Current jobs/sec | Baseline p99 sequence delay (ms) | Current p99 sequence delay (ms) | Current acquisitions/job |
| ------- | ---: | ----------------: | ---------------: | -------------------------------: | ------------------------------: | -----------------------: |
| 20.20.2 |  200 |             65.64 |            93.55 |                          1046.44 |                          141.21 |                   1.0150 |
| 20.20.2 | 2000 |             65.86 |            93.73 |                         10271.97 |                         1323.71 |                   1.0082 |
| 22.23.3 |  200 |             65.72 |            93.02 |                          1042.86 |                          154.54 |                   1.0083 |
| 22.23.3 | 2000 |             65.63 |            92.83 |                         10377.52 |                         1529.66 |                   1.0112 |
| 24.21.0 |  200 |             65.60 |            92.59 |                          1049.02 |                          162.49 |                   1.0133 |
| 24.21.0 | 2000 |             65.16 |            90.26 |                         10594.94 |                         2141.86 |                   1.0522 |

Baseline acquisitions/job are 1.0000 in all six rows. The improvement trades
some additional early denied checks for lower accumulated delay. Node 24's
2,000-job case also slightly increases median round p99 callback spacing
overshoot, from 7.21ms to 7.31ms; its worst current round uses 1.0695
acquisitions/job. All those samples are retained. No traced store admission
gap is below 10ms in either implementation.

### Synchronous memory control

| Node    | Jobs | Baseline jobs/sec | Current jobs/sec | Baseline p99 sequence delay (ms) | Current p99 sequence delay (ms) |
| ------- | ---: | ----------------: | ---------------: | -------------------------------: | ------------------------------: |
| 20.20.2 |  200 |             96.54 |            96.43 |                            81.36 |                           83.76 |
| 20.20.2 | 2000 |             95.60 |            95.72 |                           916.83 |                          892.88 |
| 22.23.3 |  200 |             97.23 |            96.54 |                            66.42 |                           81.14 |
| 22.23.3 | 2000 |             96.65 |            96.73 |                           693.71 |                          676.70 |
| 24.21.0 |  200 |             97.18 |            96.75 |                            66.82 |                           75.34 |
| 24.21.0 | 2000 |             96.09 |            96.14 |                           809.75 |                          802.75 |

The synchronous timing policy is unchanged. These small throughput differences
do not establish an improvement. The short current runs have higher sequence
delay on all three runtimes, while the longer runs have slightly lower delay;
the raw data preserves both directions. The original 5ms target fails in every
measured synchronous run.

### Sensitivity without trace hooks

A separate three-pair Node 24 run removes the trace sites from the temporary
bundles, retaining the event-loop monitor and other metrics. With 200 jobs and
5ms response delivery, median throughput is 64.51 to 87.65 jobs/sec and median
round p99 sequence delay is 1099.16 to 284.27ms. Current acquisitions/job are
1.0817 versus 1.0000 baseline. The benefit persists, while absolute timing and
denial counts vary. These runs are not paired against the traced runs and do
not isolate instrumentation overhead. The synchronous control is 94.54 to
94.92 jobs/sec, with p99 sequence delay 124.77 to 116.65ms.

## Shared-store smoke

Node 24.21.0, Redis 7.4.7 on loopback, ioredis 5.11.1, 200 jobs at 100/sec.
One 32-job warmup and one measured round per case. Eight valves share a store
in one process; the separate eight-process integration test checks admission
bounds. Redis and Valkey were built with `MALLOC=libc`, TLS disabled, and
persistence disabled for these checks. Redis remains the admission clock.

| Valves | Injected RTT (ms) | Baseline jobs/sec | Current jobs/sec | Baseline script commands/job | Current script commands/job |
| -----: | ----------------: | ----------------: | ---------------: | ---------------------------: | --------------------------: |
|      1 |                 0 |             95.77 |            94.52 |                        1.010 |                       1.015 |
|      1 |                 5 |             62.59 |            89.66 |                        1.000 |                       1.020 |
|      1 |                25 |             27.75 |            36.99 |                        1.000 |                       1.000 |
|      8 |                 0 |             94.59 |            94.79 |                        4.510 |                       5.215 |
|      8 |                 5 |             62.73 |            91.84 |                        4.515 |                       5.165 |
|      8 |                25 |             27.74 |            37.06 |                        4.650 |                       4.500 |

These are smoke results, not repeated evidence of a production throughput gain.
Injected latency uses requested sleeps before and after acquisition; it is not
a network emulator. Actual outgoing EVALSHA/EVAL calls, including fallback,
are counted; connection setup, server-internal Lua commands, and server CPU are
excluded. Pub/sub is not enabled in this harness. Eight-valve command traffic
increases about 15.6% at zero injected RTT and 14.4% at 5ms. Earlier rate checks
can increase contention even when throughput does not improve. Coordination
and traffic reduction remain owned by #12.

The [baseline](./drift-results/paced-baseline.json) and
[current](./drift-results/paced-current.json) files retain every case, CPU,
queue wait, denials, callback gaps, and each valve's last callback time. These
finite workloads complete every job, but do not establish cross-worker fairness.

## Full comparison and regression controls

Both implementations ran all 42 comparison cases, including every Bottleneck
case, with five measured rounds and the existing warmup. Node 24.21.0, Redis
7.4.7, Valkey 8.0.4, ioredis 5.11.1, and node-redis 5.12.1 were used. Complete
[baseline](./drift-results/comparison-baseline.json) and
[current](./drift-results/comparison-current.json) samples are retained.
These full programs ran current then baseline; causal claims above use the
separate alternating paired drift protocol.

The short full matrix flags throughput decreases of 20.8% for memory GCRA,
27.6% for memory global leases, and 34.8% / 33.9% / 35.6% for Valkey/node-redis
fixed-window / multi-rule / weighted cases. Many of those samples take only
4-15ms. Those results are retained rather than discarded.

Targeted controls increase each affected workload to 100,000 jobs, run three
repetitions per program, and alternate baseline/current program order over
three pairs. They retain p-limit and p-queue in the concurrency control, while
skipping Bottleneck only in these targeted programs; the two complete 42-case
runs above include it. The paired program throughput changes are:

| Workload                       | Pair 1 | Pair 2 | Pair 3 |
| ------------------------------ | -----: | -----: | -----: |
| Memory concurrency             |  -6.7% |  +5.3% | +24.8% |
| Memory GCRA                    |  -9.3% |  +1.0% | +10.8% |
| Memory global leases           |  -6.6% | +16.5% |  -3.6% |
| Valkey/node-redis fixed-window | -17.4% | +22.7% | -20.7% |
| Valkey/node-redis multi-rule   |  +2.3% | +12.7% |  +5.1% |
| Valkey/node-redis weighted     |  +6.4% |  +1.0% | -11.0% |

The unchanged p-limit control varies from -1.1% to +33.6% across these same
program pairs. The full matrix's large losses do not consistently reproduce
at the larger workload, but this does not explain the historical #12 regression.

The fixed-window case received a further three paired programs with **15
repetitions each**, retaining all 45 samples per implementation. Median
elapsed times are 217.15 to 222.29ms, 215.26 to 220.76ms, and 222.57 to
229.68ms. This is a repeatable **2.3-3.1% throughput cost** in those program
pairs. Its mechanism is not isolated here; it remains a review tradeoff, not
a claimed improvement. [All controls](./drift-results/controls.json), including
the initially aborted control's completed rows, are retained. No CI ceiling
was raised.

## Validation and size

`pnpm check` passes: lint, types, builds, 176 unit/property tests, coverage,
type tests, source checks, package exports, and bundle ceilings. Local Redis
7.4.7 passes all 20 integration tests including eight-process pacing, Cluster,
and restart recovery. Valkey 8.0.4 passes 15 applicable integration tests;
the five Cluster/restart checks run against Redis separately. Node 20/22/24
ESM/CommonJS/subpath smoke checks and all six docs browser tests pass. GitHub
also passes the Redis 6.2/7.4/8 and Valkey 7.2/8 correctness matrix.

The initial single-run CI throughput comparison measured current 360.07ms
versus baseline 222.76ms and failed its existing 15% ceiling. On the identical
source commit, its rerun measured 162.12ms versus 186.05ms and passed. Both
outcomes are recorded in [validation.json](./drift-results/validation.json);
the single-run check is not evidence of a stable throughput improvement.

Minified/gzipped ESM entries, measured with Node 24.21.0 and esbuild 0.28.2,
browser platform and ES2022 target:

| Entry   | Baseline bytes | Current bytes | CI ceiling | Original target |
| ------- | -------------: | ------------: | ---------: | --------------: |
| Core    |           8322 |          8361 |       8704 |            4096 |
| Redis   |           3525 |          3525 |       4096 |            3072 |
| Headers |           1130 |          1130 |       2048 |            2048 |

Core grows by 39 bytes. Core and Redis still exceed their original targets;
all existing ceilings pass and zero runtime dependencies remain.

## Raw evidence

[summary.json](./drift-results/summary.json) retains all 84 traced and untraced
per-round metric samples, source and harness hashes, host/runtime metadata,
and archive checksums. Full eligibility/wakeup/admission/dispatch traces are
in [Node 20](./drift-results/node20.json.gz),
[Node 22](./drift-results/node22.json.gz), and
[Node 24](./drift-results/node24.json.gz). The complete
[untraced sensitivity run](./drift-results/untraced-node24.json.gz) is retained too.
All 79,200 traced grants satisfy the 10ms store-clock spacing assertion.

```sh
gzip -dc packages/valve/bench/drift-results/node24.json.gz > /tmp/drift-node24.json
```

## Target decision

For strict burst-1 admission at 100/sec, each next eligible time follows the
actual previous store admission by 10ms. If a wakeup is late by `e[i]`, store
sequence drift accumulates as the sum of those nonnegative errors. Exact local
deadlines cannot recover already accumulated drift without an early admission
or a catch-up burst. Callback sequence delay also includes clock quantization
and changing dispatch latency, so callback gaps are not admission bounds.

Subtracting monotonic acquisition time removes avoidable response delay. It
cannot eliminate operating-system timer delivery delay, and it does not improve
the synchronous memory path's timing policy. Moving memory admission to a new
clock would change store clock semantics and would still leave timer delivery
overshoot; this change retains the current clock.

The original fixed 5ms accumulated target is **not achieved or revised** here.
A proposed replacement for review is to calibrate p99 per-gap overshoot and
store-to-dispatch latency on dedicated Node 20/22/24 runners, while retaining
200-job and 2,000-job accumulated delay as separate reported metrics. Initial
candidate thresholds for the synchronous local no-op workload are 2ms per-gap
overshoot and 1ms dispatch delay. They are measurement targets, not production
guarantees, and require runner calibration before adoption.

## Reproduction

Run the runtimes sequentially on the same host, without concurrent builds or tests:

```sh
VALVE_DRIFT_OUT=/tmp/drift-node20.json node packages/valve/bench/drift.mjs
```

Select each Node executable explicitly. `VALVE_DRIFT_REPEATS` defaults to 3,
`VALVE_DRIFT_JOBS` to `200,2000`, `VALVE_DRIFT_RESPONSE_MS` to `0,5`, and
`VALVE_DRIFT_BASELINE` to the merged PR #10 commit. `VALVE_DRIFT_TRACE=0`
disables trace collection for a sensitivity check. The report records the
runtime, host, esbuild version, baseline commit, current HEAD, and exact source
diff. Raw events remain in the output alongside all per-round samples.

For the complete comparison, start the documented Redis and Valkey versions
on ports 16379 and 16380, then prepare both bundles before timing:

```sh
git worktree add --detach /tmp/valve-drift-baseline 360621096a5b9a05b2886a17748d539cd6436cf5
pnpm --filter @ksaurav24/valve exec esbuild /tmp/valve-drift-baseline/packages/valve/src/index.ts --bundle --format=esm --platform=node --target=node20 --outfile=/tmp/valve-baseline.mjs
pnpm --filter @ksaurav24/valve exec esbuild src/index.ts --bundle --format=esm --platform=node --target=node20 --outfile=/tmp/valve-current.mjs
export REDIS_URL=redis://127.0.0.1:16379 VALKEY_URL=redis://127.0.0.1:16380
for variant in current baseline; do
  VALVE_BENCH_LIBRARY=/tmp/valve-$variant.mjs VALVE_BENCH_REVISION=$variant VALVE_BENCH_OUT=/tmp/comparison-$variant.json pnpm bench:compare
done
for variant in baseline current; do
  VALVE_BENCH_LIBRARY=/tmp/valve-$variant.mjs VALVE_BENCH_REPEATS=1 VALVE_BENCH_OUT=/tmp/paced-$variant.json pnpm bench:paced
done
```

Use Node 24.21.0 for those commands and leave scenario/competitor filters unset
for the full comparison. Targeted controls set `VALVE_BENCH_JOBS=100000`,
`VALVE_BENCH_SHARED_JOBS=100000`, `VALVE_BENCH_REPEATS=3`, and
`VALVE_BENCH_SKIP_BOTTLENECK=1`, selecting the six workload names recorded in
`controls.json`. The fixed-window followup selects only
`valkey/node-redis/fixed-window` and uses 15 repetitions. Run three program
pairs, reversing execution order for the middle pair.
