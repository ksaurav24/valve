# Historical initial measurements

For final repeated comparisons of all current workloads, see
[COMPARISON.md](./COMPARISON.md). These initial results predate shared leases.

Measured on 2026-10-07, Linux x64, Node 26.10.0, pnpm 11.28.4. The machine was
also running the server matrix and documentation checks. These are local
measurements, not CI hardware calibration or production throughput promises.

## B1: 100,000 no-op jobs, local concurrency 16

| Scheduler  |      Elapsed | Jobs per second |
| ---------- | -----------: | --------------: |
| valve      |     107.50ms |         930,274 |
| p-limit    |     148.07ms |         675,347 |
| p-queue    |     124.67ms |         802,134 |
| Bottleneck | 245,891.50ms |             407 |

Jobs are queued together. The valve rule has enough rate and burst capacity
that it never limits. Bottleneck's timer-based scheduler makes this scenario
particularly expensive. It is not a comparison of real API workload latency.
Use `pnpm bench` to reproduce it. Set `VALVE_BENCH_SKIP_BOTTLENECK=1` to skip the
long Bottleneck run. `bench/mitata.ts` provides adaptive microbenchmarks.

## B2: 2,000 jobs, 100 per second, burst 1

The p99 delay beyond the earliest allowed time following the previous start
was 2.371ms. Accumulated delay beyond the ideal 10ms sequence was 2,425.094ms.
The PRD's p99 delay against the original ideal sequence is not the same
metric, and its 5ms target is not met over this sustained run. Timer delay and
positive scheduler jitter accumulate because burst 1 prevents catch-up starts.
The benchmark reports both per-start and ideal-sequence delay for future runs.

## B3: Redis 7.4.7, localhost

- Backlog: 32 acquire calls for 1,000 jobs, or 0.0320 round trips per job.
- Light load: 10 acquire calls for 10 jobs, or 1.0000 round trip per job.
- The integration suite verifies 5,000 atomic admissions across eight child
  processes on Redis 6.2, 7.4, 8, and Valkey 7.2 and 8.

The backlog measurement allows a burst of 1,000 to isolate batching. The
multi-process correctness scenario uses 1,000 per second with burst 32.

## Bundle and release readiness

| Entry   | Minified + gzip |  PRD target | Status                                          |
| ------- | --------------: | ----------: | ----------------------------------------------- |
| Core    |     6,395 bytes | 4,096 bytes | Target unmet; CI regression ceiling 6,656 bytes |
| Redis   |     2,281 bytes | 3,072 bytes | Meets target                                    |
| Headers |     1,058 bytes | 2,048 bytes | Meets target                                    |

The core size target and ideal-sequence scheduling target remain release
readiness items. The package is not published. CI compares future local
benchmark changes with the PR base on the same runner, allowing at most 15%
regression in elapsed time and per-start p99 delay. Hardware calibration is
still an open decision.
