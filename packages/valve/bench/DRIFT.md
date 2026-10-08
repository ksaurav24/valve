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
