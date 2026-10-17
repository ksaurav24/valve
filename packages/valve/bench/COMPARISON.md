# Current benchmarks

Raw results are not kept in the repository. Links to them point to commit
[`1979020`](https://github.com/ksaurav24/valve/tree/197902098769e5abf396d16582a42d1b7a123ded/packages/valve/bench), the last revision
that contained them; rerun the commands below to regenerate them.

The follow-up [paced drift report](./DRIFT.md) measures asynchronous rate-wakeup
deadlines against the merged PR #10 baseline. The results below retain PR #10's
full comparison and historical evidence.

The [bundle footprint report](./FOOTPRINT.md) records the #16 follow-up's
module breakdown, consumer sizes, cold startup measurements, and regression
comparisons against master after #17.

## Recommendation

Choose Valve when outbound calls need shared quotas, provider feedback, or atomic
weighted admission across several rules. For concurrency alone inside one
process, start with p-limit or p-queue. The comparison below measures scheduler
workloads, not production HTTP throughput.

The footprint optimization reduces the published Redis entry from 3,521 to 3,151
gzip bytes (10.5%) and a `retryAfter()` consumer from 1,089 to 445 bytes (59.1%).
Core size is unchanged. It does not establish faster startup or lower CPU cost.
Fresh-runner throughput changes ranged from -2.2% to +7.2%, within the existing
15% regression gate; tail waits remained variable. The scheduling gate failed
once and passed on a rerun with unchanged scheduler code and thresholds; the
failed samples remain in PR #19. Do not treat these measurements as a general
latency or throughput improvement.

The trade-off is pinned build-time Lua minification and pure annotations that
must remain valid as reader factories evolve. Runtime dependencies, exports,
store behavior, and size ceilings are preserved. Core and Redis still exceed
the original footprint targets. Shared contention, global concurrency, and
priority performance remain tracked separately in #12 through #15. Read the
[footprint report](./FOOTPRINT.md) for paired sizes, raw samples, and reproduction
commands before choosing based on performance.

## Historical comparison after PR #10

Full rerun after removing positive jitter from rate eligibility waits with local concurrency. Global concurrency polling and outage backoff retain jitter. The implementation and public API are otherwise unchanged.

Measured 2026-10-07T14:51:33.144Z on 12th Gen Intel(R) Core(TM) i5-12450H, 12 logical CPUs, linux x64, v26.10.0. Redis 7.4.7 and Valkey 8.0.4 run on loopback. Dependencies: bottleneck 2.19.5, p-limit 7.3.3, p-queue 9.3.3, ioredis5 5.11.1, redis5 5.12.1.

All six benchmark programs ran sequentially, including every Bottleneck case. Builds and tests did not compete for CPU. These measurements describe scheduler/parser workloads on this host, not production HTTP throughput or operational maturity.

## Paced execution

200 queued promise-returning no-op jobs at 100/sec. Valve uses GCRA burst 1; Bottleneck uses minTime 10ms. Throughput is jobs divided by median elapsed time over five rounds. As in the previous comparison, latency percentiles and minimum callback gap are from the last measured round. All elapsed samples are in [comparison.json](https://github.com/ksaurav24/valve/blob/197902098769e5abf396d16582a42d1b7a123ded/packages/valve/bench/comparison.json).

| Library    | Jobs/sec | p99 spacing overshoot (ms) | p99 ideal-sequence delay (ms) | Minimum start gap (ms) |
| ---------- | -------: | -------------------------: | ----------------------------: | ---------------------: |
| valve      |    98.52 |                      1.299 |                        39.951 |                  9.162 |
| Bottleneck |   100.33 |                      1.649 |                         0.189 |                  8.245 |

Valve's p99 ideal-sequence delay falls from 283.320ms to 39.951ms (85.9% lower). The original 5ms target remains unmet. The PR #7 baseline and prior optimization experiments are consolidated in [optimization-history.json](https://github.com/ksaurav24/valve/blob/197902098769e5abf396d16582a42d1b7a123ded/packages/valve/bench/optimization-history.json).

Spacing overshoot is excess time beyond 10ms between callbacks. Ideal-sequence delay is `start[i] - start[0] - i * 10ms`. Small late admissions can accumulate across the queue: burst 1 schedules the next eligibility from the actual store admission and does not catch up by shortening admission spacing.

These are callback timestamps measured with performance.now(), not a store admission trace. The memory store uses Date.now(); clock resolution and delayed dispatch can produce callback gaps below 10ms even when store-clock admission obeys the rule. Actual HTTP arrival times can bunch too. Bottleneck's minTime scheduling has different semantics; its lower accumulated drift does not establish the same atomic GCRA admission guarantee. Correctness is checked separately by the eight-process real-store tests.

## All 42 scheduling workloads

Each case has one warmup of up to 1,000 jobs, then five measured repetitions. Setup, connection establishment, and warmup are excluded. A new Valve budget awaits pub/sub readiness inside its first acquire, so that cost is included; Bottleneck ready() is awaited before timing. IDs are fresh each round.

Local cases queue 10,000 jobs with concurrency 16. Rate cases have nonbinding quotas and measure algorithm overhead. Costs cycle 1, 2, 3 for weighted cases; priorities cycle 0 through 9. Async cases run 512 callbacks sleeping 5ms. Shared rate cases queue 2,000 jobs; shared lease cases queue 1,000 jobs with limit 16. Each shared case uses one scheduler, not eight-process throughput.

Elapsed, wait, service, and CPU columns are milliseconds. Wait/service percentiles are from the last round. CPU is mean user plus system time per round, including harness and GC. Store calls are logical acquire/release/renew calls, excluding pub/sub and NOSCRIPT fallback; they are not total Redis command traffic. JSON heap deltas are not peak memory. Five samples do not establish statistical significance.

| Workload                       |    Library |   Jobs | Median elapsed |     Elapsed range |  Jobs/sec | p50 wait | p99 wait | p99 service |     CPU | Acquire/job | Store calls/job |
| ------------------------------ | ---------: | -----: | -------------: | ----------------: | --------: | -------: | -------: | ----------: | ------: | ----------: | --------------: |
| memory/concurrency             |      valve | 10,000 |          12.96 |        8.37-28.18 |   771,599 |    10.67 |    12.11 |       0.000 |   34.89 |           - |               - |
| memory/gcra                    |      valve | 10,000 |          11.11 |        8.85-12.34 |   900,304 |     4.03 |     5.79 |       0.000 |   21.91 |           - |               - |
| memory/fixed-window            |      valve | 10,000 |          11.20 |        7.54-13.09 |   892,668 |     4.05 |     4.74 |       0.000 |   20.66 |           - |               - |
| memory/multi-rule              |      valve | 10,000 |          10.23 |        7.63-15.94 |   977,581 |     4.81 |     7.97 |       0.000 |   23.44 |           - |               - |
| memory/weighted                |      valve | 10,000 |          10.75 |        6.83-13.43 |   929,998 |     8.01 |     8.92 |       0.000 |   20.24 |           - |               - |
| memory/priority                |      valve | 10,000 |          14.23 |       10.04-17.03 |   702,592 |     5.59 |     9.24 |       0.000 |   26.06 |           - |               - |
| memory/global-16               |      valve | 10,000 |          40.84 |       39.34-41.40 |   244,863 |    18.12 |    39.63 |       0.000 |   77.55 |           - |               - |
| memory/concurrency             |    p-limit | 10,000 |           9.50 |        7.53-13.83 | 1,052,125 |     3.99 |     5.44 |       0.000 |   14.33 |           - |               - |
| memory/concurrency             |    p-queue | 10,000 |          13.94 |       11.95-18.98 |   717,332 |     8.01 |     8.76 |       0.000 |   28.90 |           - |               - |
| memory/concurrency             | Bottleneck | 10,000 |       23086.38 | 23002.28-23132.94 |       433 | 11519.73 | 22721.87 |       0.003 | 2214.58 |           - |               - |
| async-5ms/concurrency          |      valve |    512 |         167.39 |     166.60-167.87 |     3,059 |    83.75 |   161.90 |       5.358 |    5.37 |           - |               - |
| async-5ms/concurrency          |    p-limit |    512 |         166.88 |     165.81-168.74 |     3,068 |    83.96 |   160.56 |       5.470 |    5.50 |           - |               - |
| async-5ms/concurrency          |    p-queue |    512 |         166.24 |     164.01-167.49 |     3,080 |    82.88 |   160.33 |       5.478 |    5.09 |           - |               - |
| async-5ms/concurrency          | Bottleneck |    512 |        1195.27 |   1183.86-1200.15 |       428 |   600.75 |  1179.87 |       6.054 |  119.10 |           - |               - |
| paced-100/s                    |      valve |    200 |        2030.10 |   2025.45-2033.56 |        99 |  1019.57 |  2020.04 |       0.002 |   24.04 |           - |               - |
| paced-100/s                    | Bottleneck |    200 |        1993.45 |   1993.27-1994.16 |       100 |  1001.02 |  1981.82 |       0.003 |   78.97 |           - |               - |
| redis/ioredis/gcra             |      valve |  2,000 |           7.07 |        6.65-14.25 |   282,722 |     3.94 |     6.12 |       0.000 |   15.17 |      0.0315 |          0.0315 |
| redis/ioredis/fixed-window     |      valve |  2,000 |           6.86 |         4.67-7.51 |   291,508 |     2.21 |     4.18 |       0.000 |    8.98 |      0.0315 |          0.0315 |
| redis/ioredis/multi-rule       |      valve |  2,000 |           7.41 |        5.57-15.95 |   270,011 |     3.89 |     6.83 |       0.000 |   12.14 |      0.0315 |          0.0315 |
| redis/ioredis/weighted         |      valve |  2,000 |          10.64 |        5.49-19.83 |   188,023 |     6.99 |     8.53 |       0.000 |   16.23 |      0.0315 |          0.0315 |
| redis/ioredis/priority         |      valve |  2,000 |           9.13 |        5.55-11.09 |   219,103 |     3.20 |     4.98 |       0.000 |    6.47 |      0.0315 |          0.0315 |
| redis/ioredis/global-16        |      valve |  1,000 |          15.54 |       11.88-17.43 |    64,370 |     6.68 |    17.01 |       0.001 |   13.22 |      0.1250 |          0.1880 |
| redis/node-redis/gcra          |      valve |  2,000 |          10.00 |        6.79-11.64 |   200,013 |     4.45 |     6.19 |       0.000 |   11.28 |      0.0315 |          0.0315 |
| redis/node-redis/fixed-window  |      valve |  2,000 |           5.78 |         4.74-8.88 |   346,080 |     2.42 |     4.09 |       0.000 |    8.15 |      0.0315 |          0.0315 |
| redis/node-redis/multi-rule    |      valve |  2,000 |           5.98 |         5.46-8.12 |   334,366 |     2.89 |     5.01 |       0.000 |    5.19 |      0.0315 |          0.0315 |
| redis/node-redis/weighted      |      valve |  2,000 |           5.57 |         4.85-8.80 |   359,272 |     2.81 |     4.53 |       0.000 |    5.49 |      0.0315 |          0.0315 |
| redis/node-redis/priority      |      valve |  2,000 |           5.13 |         4.79-5.36 |   390,078 |     2.96 |     4.72 |       0.000 |    3.55 |      0.0315 |          0.0315 |
| redis/node-redis/global-16     |      valve |  1,000 |          17.31 |       12.19-21.48 |    57,760 |     6.27 |    11.94 |       0.000 |   11.56 |      0.1250 |          0.1880 |
| redis/global-16                | Bottleneck |  1,000 |         246.49 |     217.01-271.00 |     4,057 |   133.81 |   264.62 |       0.002 |  287.26 |           - |               - |
| valkey/ioredis/gcra            |      valve |  2,000 |           6.28 |         5.77-8.97 |   318,302 |     2.93 |     5.30 |       0.000 |    6.16 |      0.0315 |          0.0315 |
| valkey/ioredis/fixed-window    |      valve |  2,000 |           8.71 |        5.95-12.87 |   229,689 |     4.73 |     7.88 |       0.000 |    9.25 |      0.0315 |          0.0315 |
| valkey/ioredis/multi-rule      |      valve |  2,000 |           7.84 |        6.37-13.90 |   255,178 |     3.09 |     5.87 |       0.000 |   11.49 |      0.0315 |          0.0315 |
| valkey/ioredis/weighted        |      valve |  2,000 |           6.12 |        5.40-10.30 |   326,595 |     4.99 |     7.78 |       0.001 |    6.80 |      0.0315 |          0.0315 |
| valkey/ioredis/priority        |      valve |  2,000 |           4.99 |         4.86-7.89 |   401,123 |     2.71 |     4.50 |       0.000 |    4.98 |      0.0315 |          0.0315 |
| valkey/ioredis/global-16       |      valve |  1,000 |          14.57 |       11.22-18.26 |    68,647 |     6.26 |    14.13 |       0.001 |   10.76 |      0.1250 |          0.1880 |
| valkey/node-redis/gcra         |      valve |  2,000 |           5.51 |         5.12-6.52 |   362,882 |     3.02 |     5.08 |       0.000 |    3.50 |      0.0315 |          0.0315 |
| valkey/node-redis/fixed-window |      valve |  2,000 |           5.31 |         4.40-7.07 |   376,994 |     2.57 |     4.85 |       0.000 |    3.20 |      0.0315 |          0.0315 |
| valkey/node-redis/multi-rule   |      valve |  2,000 |           6.58 |         5.49-8.44 |   303,867 |     2.69 |     8.04 |       0.000 |    5.47 |      0.0315 |          0.0315 |
| valkey/node-redis/weighted     |      valve |  2,000 |           4.95 |        4.43-10.72 |   404,323 |     8.51 |    10.28 |       0.000 |    5.80 |      0.0315 |          0.0315 |
| valkey/node-redis/priority     |      valve |  2,000 |           4.58 |         4.30-9.57 |   436,252 |     6.91 |     9.12 |       0.001 |    6.14 |      0.0315 |          0.0315 |
| valkey/node-redis/global-16    |      valve |  1,000 |          15.10 |       11.78-15.76 |    66,243 |     6.06 |    11.54 |       0.000 |    9.46 |      0.1250 |          0.1880 |
| valkey/global-16               | Bottleneck |  1,000 |         230.25 |     177.09-244.44 |     4,343 |   115.43 |   224.69 |       0.001 |  234.73 |           - |               - |

## Header readers

10,000 warmup reads, then five batches of 1,000,000 reads from a plain header object. These are parser operations, not scheduled jobs or network throughput. Raw samples: [headers.json](https://github.com/ksaurav24/valve/blob/197902098769e5abf396d16582a42d1b7a123ded/packages/valve/bench/headers.json).

| Reader            |  Reads/sec | Median elapsed (ms) | Elapsed range (ms) |
| ----------------- | ---------: | ------------------: | -----------------: |
| Retry-After       | 21,679,307 |               46.13 |        44.74-48.44 |
| IETF RateLimit    |  3,279,972 |              304.88 |      294.62-315.78 |
| X-RateLimit       |  9,714,746 |              102.94 |      102.38-110.29 |
| combined feedback |  1,894,678 |              527.79 |      523.02-546.11 |

## Shared pacing and injected latency

Each case queues 200 jobs at 100/sec, with one 32-job warmup and five measured rounds. Eight valves here share a store inside one process. Redis uses an ioredis5 adapter without pub/sub. Injected RTT is requested sleep split before and after acquire, in addition to loopback latency; actual timer delivery may add delay. This is not a network emulator. Redis remains the clock authority.

Throughput uses median elapsed time. The delay column is the median of each round's p99 ideal delay, not a pooled percentile. Script commands count actual outgoing EVALSHA/EVAL invocations, including fallback, but exclude connection setup and commands executed inside Lua. Raw samples, CPU, zero-grant acquires, callback gaps, queue wait, and per-valve completion times are in [paced.json](https://github.com/ksaurav24/valve/blob/197902098769e5abf396d16582a42d1b7a123ded/packages/valve/bench/paced.json).

| Store  | Valves | Injected RTT (ms) | Jobs/sec | Median round p99 ideal delay (ms) | Script commands/job |
| ------ | -----: | ----------------: | -------: | --------------------------------: | ------------------: |
| memory |      1 |                 0 |    98.34 |                            43.511 |               0.000 |
| memory |      8 |                 0 |    99.00 |                            29.705 |               0.000 |
| redis  |      1 |                 0 |    94.95 |                           115.334 |               1.020 |
| redis  |      1 |                 5 |    63.01 |                          1172.584 |               1.000 |
| redis  |      1 |                25 |    27.88 |                          5132.101 |               1.000 |
| redis  |      8 |                 0 |    94.21 |                           131.831 |               5.229 |
| redis  |      8 |                 5 |    63.28 |                          1158.830 |               5.029 |
| redis  |      8 |                25 |    27.90 |                          5125.778 |               4.737 |

Removing jitter can increase acquire collisions between workers. These measurements do not establish cross-worker fairness. The historical isolated Valkey/node-redis nonbinding multi-rule runs showed 14.4% lower pooled median throughput; the cause remains unresolved. The new short full-matrix run does not resolve that finding or prove a general scheduler speedup. The underlying experiments remain in optimization-history.json.

## Long local benchmark

A single run of 100,000 synchronous no-op jobs at concurrency 16, with a nonbinding Valve rate rule. This harness includes setup and has no warmup. It is a different workload from the repeated promise-returning comparison above. All four libraries ran, including Bottleneck. Raw output: [local.json](https://github.com/ksaurav24/valve/blob/197902098769e5abf396d16582a42d1b7a123ded/packages/valve/bench/local.json).

| Library    | Elapsed (ms) | Jobs/sec |
| ---------- | -----------: | -------: |
| valve      |       134.16 |  745,374 |
| p-limit    |       169.27 |  590,782 |
| p-queue    |       139.68 |  715,917 |
| Bottleneck |    233294.40 |      429 |

The same program queues 2,000 burst-1 jobs at 100/sec. p99 spacing overshoot is 0.366ms, p99 ideal-sequence delay is 376.061ms, and accumulated final delay is 379.085ms. The original 5ms ideal-sequence target remains unmet over this longer run too.

## Store acquisition and adaptive microbenchmarks

redis.ts ran against both Redis and Valkey. The backlog case admits 1,000 queued jobs with burst 1,000 to isolate batching; the light case submits ten jobs separately, sleeping 5ms between submissions. These are logical acquire counts.

| Store  |    Case | Acquires | Jobs | Acquires/job |
| ------ | ------: | -------: | ---: | -----------: |
| redis  | backlog |       32 | 1000 |       0.0320 |
| redis  |   light |       10 |   10 |       1.0000 |
| valkey | backlog |       32 | 1000 |       0.0320 |
| valkey |   light |       10 |   10 |       1.0000 |

mitata.ts ran both adaptive 1,000-job local microbenchmarks. Its complete console output and both store-acquisition outputs are retained in [supplementary.json](https://github.com/ksaurav24/valve/blob/197902098769e5abf396d16582a42d1b7a123ded/packages/valve/bench/supplementary.json). Adaptive batch timings should not be read as per-job HTTP latency.

```text
clk: ~4.19 GHz
cpu: 12th Gen Intel(R) Core(TM) i5-12450H
runtime: node 26.10.0 (x64-linux)

benchmark                      avg (min … max) p75 / p99    (min … top 1%)
---------------------------------------------- -------------------------------
valve, 1000 queued no-op jobs   376.24 µs/iter 384.52 µs  █
                         (266.47 µs … 2.16 ms) 900.99 µs  █▆▂
                       (129.77 kb …   2.25 mb)   1.10 mb ▂███▇▅▂▂▁▁▁▂▂▂▁▂▂▁▁▁▁

p-queue, 1000 queued no-op jobs 700.83 µs/iter 683.68 µs  ▆█
                         (481.50 µs … 3.10 ms)   1.91 ms  ██▅
                       (414.80 kb …   3.30 mb)   1.96 mb ▆███▃▂▂▂▁▁▁▁▁▁▁▂▁▂▂▁▁
```

## Bundle sizes

Bundled, minified, gzipped ESM entries, browser platform and ES2022 target. Core grew by five bytes for the jitter condition. Zero runtime dependencies remain.

| Entry   | Bytes | CI ceiling | Original target |
| ------- | ----: | ---------: | --------------: |
| Core    | 8,299 |      8,704 |           4,096 |
| Redis   | 3,516 |      4,096 |           3,072 |
| Headers | 1,127 |      2,048 |           2,048 |

Core and Redis still exceed their original size targets. The measured output is also retained in supplementary.json.

## Reproduce

Run these sequentially from the repository root. Redis and Valkey must be available for their cases. Use fresh output files when comparing changes.

```sh
REDIS_URL=redis://127.0.0.1:6379 VALKEY_URL=redis://127.0.0.1:6380 pnpm bench:compare
pnpm --filter valvejs exec tsx bench/headers.ts
REDIS_URL=redis://127.0.0.1:6379 VALVE_BENCH_OUT=bench/paced.json pnpm bench:paced
VALVE_BENCH_OUT=bench/local.json pnpm bench
REDIS_URL=redis://127.0.0.1:6379 pnpm --filter valvejs exec tsx bench/redis.ts
REDIS_URL=redis://127.0.0.1:6380 pnpm --filter valvejs exec tsx bench/redis.ts
pnpm --filter valvejs exec tsx bench/mitata.ts
pnpm check:size
```

The comparison supports VALVE_BENCH_REPEATS, VALVE_BENCH_JOBS, VALVE_BENCH_SHARED_JOBS, VALVE_BENCH_SCENARIOS (comma-separated exact names), VALVE_BENCH_OUT, and VALVE_BENCH_LIBRARY (a baseline source entry). VALVE_BENCH_SKIP_BOTTLENECK skips its long cases when explicitly set; it was unset for this full rerun. Omit store URLs for local-only comparisons.

Superseded snapshot files and duplicate reports were removed. COMPARISON.md is the current report; canonical raw files describe the latest runs, and optimization-history.json preserves the prior baseline and optimization evidence.
