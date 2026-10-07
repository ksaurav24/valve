# Scheduling benchmarks

Measured 2026-10-07T10:19:20.848Z on 12th Gen Intel(R) Core(TM) i5-12450H, 12 logical CPUs,
Linux x64, Node v26.10.0. Redis 7.4.7 and Valkey 8.0.4 run on loopback.
Dependencies: bottleneck 2.19.5, p-limit 7.3.3, p-queue 9.3.3, ioredis5 5.11.1, redis5 5.12.1.

## Method

Every case has one warmup (up to 1,000 jobs), then five measured repetitions.
Jobs return promises. Factory setup, connection establishment and warmup are
excluded. Valve awaits each new ID's pub/sub subscription inside its first
scheduled acquire, so that readiness cost is included; Bottleneck's `ready()`
is awaited before timing. Cases run sequentially without builds or tests sharing
the CPU. Median throughput is jobs divided by median elapsed time, not an
average of reciprocal rates. Every elapsed sample is in [comparison.json](./comparison.json).

Local cases enqueue 10,000 jobs with concurrency 16. Rate cases use a large
nonbinding quota and burst; they measure algorithm overhead rather than rate
accuracy. Weighted costs cycle 1, 2, 3; priorities cycle 0 through 9. Async cases
use 512 callbacks sleeping 5ms. Paced cases use 200 jobs at a requested 100/sec:
valve uses GCRA burst 1; Bottleneck uses minTime 10ms. These policies have
similar intent but different scheduling semantics.

Shared-store rate cases enqueue 2,000 jobs; global concurrency cases enqueue
1,000 with a limit of 16. The memory global case measures lease overhead within
one process; global scope needs a shared backend to coordinate processes. Valve also has a nonbinding GCRA rule. Bottleneck uses
its ioredis datastore. Each round uses a fresh ID. Global cases measure one
scheduler using a shared backend; they do not measure eight-worker throughput.
Separate integration tests check eight-process bounds and worker death.

No-op callback bodies finish synchronously before their promise resolves, so
observed callback concurrency can be 1 despite a configured limit of 16.
These large rates are scheduler capacity, not HTTP request throughput.
Latency percentiles are from the last measured round, including initial queue
backlog. CPU is mean user plus system time per round. Heap deltas in JSON are
GC-sensitive and do not measure peak memory. Store calls count logical acquire,
release and renewal API calls, excluding pub/sub and NOSCRIPT fallback traffic;
they are not a Redis wire-command trace. Other libraries' store calls were not
instrumented. Distributed lease semantics differ between the libraries.

Initial three-repeat and intermediate five-repeat samples are retained in
[comparison-initial.json](./comparison-initial.json) and
[comparison-warmed.json](./comparison-warmed.json). The pre-release-race sample
is also retained in [comparison-before-release-race.json](./comparison-before-release-race.json).
They show run variability;
the table below uses the final implementation, including the release-wakeup
race fix and Cluster compatibility. No statistical
significance or production reliability claim is inferred from five samples.

## All scheduling workloads

Elapsed columns are milliseconds. Throughput is jobs/sec; CPU is ms per batch.

| Workload                       | Library    |   Jobs | Median elapsed |     Elapsed range | Jobs/sec | p50 wait | p99 wait | p99 service |     CPU | Acquire/job | Store calls/job |
| ------------------------------ | ---------- | -----: | -------------: | ----------------: | -------: | -------: | -------: | ----------: | ------: | ----------: | --------------: |
| memory/concurrency             | valve      | 10,000 |          12.82 |        7.24-23.01 |  779,932 |     3.91 |     4.43 |       0.000 |   29.45 |           - |               - |
| memory/gcra                    | valve      | 10,000 |          10.20 |        6.85-15.47 |  980,192 |     3.32 |     4.64 |       0.000 |   27.91 |           - |               - |
| memory/fixed-window            | valve      | 10,000 |          10.79 |        6.47-11.77 |  926,394 |     3.74 |     4.33 |       0.000 |   19.12 |           - |               - |
| memory/multi-rule              | valve      | 10,000 |          10.87 |        7.30-11.79 |  919,963 |     3.89 |     4.45 |       0.000 |   17.98 |           - |               - |
| memory/weighted                | valve      | 10,000 |          10.99 |        7.65-13.15 |  909,932 |     4.31 |     7.51 |       0.000 |   20.15 |           - |               - |
| memory/priority                | valve      | 10,000 |          13.53 |        9.81-26.64 |  739,134 |    11.70 |    15.78 |       0.000 |   37.08 |           - |               - |
| memory/global-16               | valve      | 10,000 |          33.30 |       32.25-40.82 |  300,272 |    14.50 |    31.30 |       0.000 |   65.51 |           - |               - |
| memory/concurrency             | p-limit    | 10,000 |          12.48 |       12.29-16.01 |  801,011 |     9.09 |     9.85 |       0.000 |   18.72 |           - |               - |
| memory/concurrency             | p-queue    | 10,000 |          14.05 |       12.40-18.10 |  711,806 |     7.74 |     8.99 |       0.000 |   27.75 |           - |               - |
| memory/concurrency             | Bottleneck | 10,000 |       23043.77 | 22885.77-23227.55 |      434 | 11439.33 | 22615.98 |       0.003 | 2181.88 |           - |               - |
| async-5ms/concurrency          | valve      |    512 |         167.83 |     165.76-169.43 |    3,051 |    84.07 |   161.76 |       5.804 |    9.12 |           - |               - |
| async-5ms/concurrency          | p-limit    |    512 |         166.52 |     165.83-166.78 |    3,075 |    83.49 |   161.02 |       5.303 |    3.33 |           - |               - |
| async-5ms/concurrency          | p-queue    |    512 |         166.64 |     165.74-170.52 |    3,073 |    82.96 |   160.96 |       5.669 |   10.36 |           - |               - |
| async-5ms/concurrency          | Bottleneck |    512 |        1197.84 |   1180.05-1205.54 |      427 |   598.32 |  1177.60 |       6.118 |  125.03 |           - |               - |
| paced-100/s                    | valve      |    200 |        2271.40 |   2247.01-2280.68 |       88 |  1142.97 |  2263.40 |       0.003 |   34.22 |           - |               - |
| paced-100/s                    | Bottleneck |    200 |        1994.97 |   1991.79-1996.89 |      100 |  1001.45 |  1981.68 |       0.004 |   81.66 |           - |               - |
| redis/ioredis/gcra             | valve      |  2,000 |           9.15 |        7.83-18.03 |  218,548 |     6.10 |     8.15 |       0.000 |   17.21 |      0.0315 |          0.0315 |
| redis/ioredis/fixed-window     | valve      |  2,000 |           6.35 |         5.81-7.26 |  315,068 |     3.27 |     5.29 |       0.000 |    7.87 |      0.0315 |          0.0315 |
| redis/ioredis/multi-rule       | valve      |  2,000 |           8.73 |        6.59-12.83 |  229,137 |     7.48 |    12.09 |       0.001 |   14.75 |      0.0315 |          0.0315 |
| redis/ioredis/weighted         | valve      |  2,000 |           7.30 |         6.35-8.22 |  273,990 |     3.53 |     7.52 |       0.000 |    5.54 |      0.0315 |          0.0315 |
| redis/ioredis/priority         | valve      |  2,000 |           7.37 |         5.09-7.98 |  271,426 |     3.02 |     6.79 |       0.000 |    6.05 |      0.0315 |          0.0315 |
| redis/ioredis/global-16        | valve      |  1,000 |          17.13 |       12.39-21.34 |   58,362 |     7.16 |    12.71 |       0.000 |   13.95 |       0.125 |           0.188 |
| redis/node-redis/gcra          | valve      |  2,000 |           9.13 |        7.90-11.19 |  218,956 |     4.56 |     7.04 |       0.000 |    9.97 |      0.0315 |          0.0315 |
| redis/node-redis/fixed-window  | valve      |  2,000 |           9.37 |        6.90-10.41 |  213,452 |     3.26 |     6.34 |       0.000 |    8.85 |      0.0315 |          0.0315 |
| redis/node-redis/multi-rule    | valve      |  2,000 |           7.96 |        6.88-10.42 |  251,189 |     3.67 |     6.21 |       0.000 |    5.80 |      0.0315 |          0.0315 |
| redis/node-redis/weighted      | valve      |  2,000 |           5.89 |        5.34-11.58 |  339,467 |     2.74 |    10.89 |       0.000 |    6.39 |      0.0315 |          0.0315 |
| redis/node-redis/priority      | valve      |  2,000 |           9.55 |        6.70-12.96 |  209,322 |     8.62 |    12.19 |       0.000 |    8.43 |      0.0315 |          0.0315 |
| redis/node-redis/global-16     | valve      |  1,000 |          20.23 |       13.02-28.19 |   49,428 |     6.91 |    12.71 |       0.000 |   26.36 |       0.125 |           0.188 |
| redis/global-16                | Bottleneck |  1,000 |         243.82 |     218.69-250.99 |    4,101 |   130.37 |   239.80 |       0.001 |  272.44 |           - |               - |
| valkey/ioredis/gcra            | valve      |  2,000 |           6.63 |        5.40-11.61 |  301,569 |     6.12 |     9.44 |       0.000 |    8.58 |      0.0315 |          0.0315 |
| valkey/ioredis/fixed-window    | valve      |  2,000 |           6.70 |         4.32-8.26 |  298,321 |     2.21 |     3.87 |       0.000 |    5.11 |      0.0315 |          0.0315 |
| valkey/ioredis/multi-rule      | valve      |  2,000 |           7.31 |        5.34-15.58 |  273,596 |     3.35 |     6.37 |       0.000 |   11.97 |      0.0315 |          0.0315 |
| valkey/ioredis/weighted        | valve      |  2,000 |           5.96 |         4.80-7.68 |  335,444 |     4.54 |     6.47 |       0.000 |    5.21 |      0.0315 |          0.0315 |
| valkey/ioredis/priority        | valve      |  2,000 |           4.99 |        4.52-10.40 |  400,486 |     2.96 |     4.71 |       0.000 |    6.27 |      0.0315 |          0.0315 |
| valkey/ioredis/global-16       | valve      |  1,000 |          14.55 |       13.63-15.88 |   68,711 |     9.83 |    15.69 |       0.000 |   11.99 |       0.125 |           0.188 |
| valkey/node-redis/gcra         | valve      |  2,000 |           6.26 |         5.16-6.89 |  319,522 |     3.98 |     5.83 |       0.000 |    5.63 |      0.0315 |          0.0315 |
| valkey/node-redis/fixed-window | valve      |  2,000 |           6.40 |         4.57-7.46 |  312,602 |     5.42 |     6.99 |       0.000 |    6.21 |      0.0315 |          0.0315 |
| valkey/node-redis/multi-rule   | valve      |  2,000 |           4.88 |         4.62-7.92 |  409,432 |     2.34 |     4.18 |       0.000 |    4.85 |      0.0315 |          0.0315 |
| valkey/node-redis/weighted     | valve      |  2,000 |           5.13 |         4.93-8.12 |  389,806 |     2.90 |     4.64 |       0.000 |    4.93 |      0.0315 |          0.0315 |
| valkey/node-redis/priority     | valve      |  2,000 |           5.26 |         4.99-8.62 |  380,385 |     3.02 |     4.64 |       0.000 |    6.08 |      0.0315 |          0.0315 |
| valkey/node-redis/global-16    | valve      |  1,000 |          13.53 |       13.30-17.22 |   73,931 |     6.66 |    13.05 |       0.001 |    9.69 |       0.125 |           0.188 |
| valkey/global-16               | Bottleneck |  1,000 |         219.16 |     194.17-228.49 |    4,563 |   114.27 |   219.52 |       0.002 |  210.38 |           - |               - |

## Paced execution

Spacing overshoot measures excess time beyond 10ms between successive starts.
Ideal-sequence delay measures drift from the first start plus 10ms per job.
These are different quantities; low spacing overshoot can accumulate into
substantial sequence drift.

| Library    | Jobs/sec | p99 spacing overshoot (ms) | p99 ideal-sequence delay (ms) | Minimum start gap (ms) |
| ---------- | -------: | -------------------------: | ----------------------------: | ---------------------: |
| valve      |    88.05 |                      2.458 |                       283.320 |                 10.160 |
| Bottleneck |   100.25 |                      1.941 |                         1.096 |                  7.252 |

Valve's conservative wakeup jitter reduces achieved rate here. Bottleneck stays
closer to 100/sec. Valve's original PRD 5ms ideal-sequence p99 target remains
unmet; the historical 2,000-job case is in [RESULTS.md](./RESULTS.md).

## Header readers

Each reader uses 10,000 warmup reads and five batches of 1,000,000 reads from a
plain header object containing Retry-After, IETF and X-RateLimit headers. These
are parser operations, not scheduled jobs or network throughput. Raw samples
are in [headers.json](./headers.json).

| Reader            |  Reads/sec | Median elapsed (ms) |
| ----------------- | ---------: | ------------------: |
| Retry-After       | 19,940,079 |               50.15 |
| IETF RateLimit    |  3,407,722 |              293.45 |
| X-RateLimit       |  9,381,894 |              106.59 |
| combined feedback |  1,923,869 |              519.79 |

## What the comparison supports

Valve measured 1,797 times
Bottleneck's throughput on the local no-op case, and
7.14 times on the short asynchronous case.
For the shared concurrency cases, valve measured approximately 12.1-16.2 times
Bottleneck's throughput across the two clients and two servers on this host.
These ratios describe these workloads only.

The likely reasons are valve's synchronous memory acquisition, coalesced
microtask queue draining and batched Redis acquisition/release. Bottleneck's
[local datastore](https://github.com/SGrondin/bottleneck/blob/master/src/LocalDatastore.coffee)
yields through timers during bookkeeping. This is a source-based explanation,
not an isolated causal experiment or a benchmark published by Bottleneck.

p-limit was faster for pure concurrency, and the three lightweight schedulers
were close on 5ms callbacks. Bottleneck was better at the paced target. Genuine
network latency, payloads, contention, Redis RTT, queue arrival patterns, and
workload duration can change these results considerably.

Valve offers atomic multiple rate rules, both GCRA and fixed windows, batched
shared acquisition, lease concurrency, provider-header feedback and fetch
retries with zero runtime dependencies. Bottleneck's
[documented features](https://github.com/SGrondin/bottleneck) include groups,
reservoir controls, chaining and clustering. This benchmark does not evaluate
all those features, queue persistence, fairness across workers, deployment
history, operational maturity or long-duration reliability. Valve remains an
unpublished 0.1.0 implementation; higher throughput is not proof of greater
maturity. Both valve and Bottleneck declare zero runtime dependencies; this
is not a differentiator between them.

## Reproduce

```sh
REDIS_URL=redis://127.0.0.1:6379 VALKEY_URL=redis://127.0.0.1:6380 pnpm bench:compare
pnpm --filter @ksaurav24/valve exec tsx bench/headers.ts
```

Use `VALVE_BENCH_REPEATS`, `VALVE_BENCH_JOBS` and `VALVE_BENCH_OUT` to change
repetition count, local job count and output path. Leave the Redis URL variables
unset to run only local comparisons. Keep raw samples when changing conditions.

## Bundle sizes

Bundled, minified, gzipped ESM entry points measured with esbuild, browser
platform and ES2022 target after this implementation:

| Entry   | Bytes | CI regression ceiling | Original PRD target |
| ------- | ----: | --------------------: | ------------------: |
| Core    | 8,294 |                 8,704 |               4,096 |
| Redis   | 3,516 |                 4,096 |               3,072 |
| Headers | 1,127 |                 2,048 |               2,048 |

Core and Redis exceed their original targets. Shared leases, renewal handling
and pub/sub add code; the CI ceilings make that accepted scope increase
explicit without claiming the original targets were met.
