# `maxWait: 0` with asynchronous stores

Benchmark evidence for issue #92. Before the fix, a `maxWait: 0` job queued
behind an in-flight store call was rejected by its expiry timer without ever
reaching the store. Sync stores send every batch before any timer runs, so only
asynchronous stores (Redis, Valkey, custom network stores) were affected.

## Protocol

`bench/zero-wait.ts` submits `maxWait: 0` jobs (no-op functions) to valves with
`concurrency: 64` and measures, per run, the store calls, the jobs sent to the
store, the jobs that ran, and the wall time per job.

- Stores: memory (sync), memory wrapped async (resolves in a microtask), Redis
  7.4.11 and Valkey 8.1.10 on loopback through ioredis 5.
- Rules: `free` (no denials), `limited` (one shared 256-job budget, so total
  grants must be 256), `scoped` (half the jobs share one identity limited to 1).
- Batch sizes 1, 32 and 128. Contention: 1 or 4 valves with the same id and
  shared store state, 512 jobs each. 3 repetitions.
- Before and after both load a built `dist` from the same toolchain: before is
  `master` (`1979020`), after is this branch. Node.js v26.8.1, Linux, 12 cores.

```sh
pnpm build
REDIS_URL=redis://127.0.0.1:6379 VALKEY_URL=redis://127.0.0.1:16880 \
  VALVE_BENCH_LIBRARY=$PWD/dist/index.js \
  VALVE_BENCH_REDIS_LIBRARY=$PWD/dist/redis/index.js \
  VALVE_BENCH_OUT=bench/zero-wait-results/after.json \
  pnpm exec tsx bench/zero-wait.ts
```

Raw rows: `zero-wait-results/before.json` and `after.json`.

## Results

- Before: with Redis or Valkey, between 1 and 448 jobs per run reached the
  store, varying between repetitions. With batch 1, a single job did. Memory
  and async memory evaluated every job.
- After: every Redis and Valkey configuration ran the same number of jobs as
  memory (512 or 2048 free, 256 limited, 257 scoped), identical in every
  repetition. Store calls match memory for `free` and `scoped`.
- `limited` sends fewer jobs to Redis than to memory (for example 309 vs 505 on average at
  batch 32). After a partial denial the valve waits for the rate hint, so later
  zero-wait jobs are rejected without an attempt they cannot win. The memory
  store sends more because each expiring job's timer clears that wait and
  pumps again. Grants are the same.
- Redis µs/job goes up at batch 1 because before, almost every job was rejected
  locally without a round trip. After, each job costs one round trip, as on any
  other Redis admission.

| Rule    | Store        | Batch | Workers | Jobs | Sent (before → after) | OK (before → after) | Store calls (before → after) | µs/job median (before → after) |
| ------- | ------------ | ----- | ------- | ---- | --------------------- | ------------------- | ---------------------------- | ------------------------------ |
| free    | memory       | 1     | 1       | 512  | 512 → 512             | 512 → 512           | 512 → 512                    | 4.24 → 4.30                    |
| free    | memory       | 1     | 4       | 2048 | 2048 → 2048           | 2048 → 2048         | 2048 → 2048                  | 2.27 → 3.94                    |
| free    | memory       | 32    | 1       | 512  | 512 → 512             | 512 → 512           | 16 → 16                      | 1.93 → 1.80                    |
| free    | memory       | 32    | 4       | 2048 | 2048 → 2048           | 2048 → 2048         | 64 → 64                      | 1.96 → 1.29                    |
| free    | memory       | 128   | 1       | 512  | 512 → 512             | 512 → 512           | 8 → 8                        | 1.90 → 0.96                    |
| free    | memory       | 128   | 4       | 2048 | 2048 → 2048           | 2048 → 2048         | 32 → 32                      | 1.10 → 1.11                    |
| free    | memory-async | 1     | 1       | 512  | 512 → 512             | 512 → 512           | 512 → 512                    | 2.25 → 2.35                    |
| free    | memory-async | 1     | 4       | 2048 | 2048 → 2048           | 2048 → 2048         | 2048 → 2048                  | 1.92 → 1.93                    |
| free    | memory-async | 32    | 1       | 512  | 512 → 512             | 512 → 512           | 16 → 16                      | 0.84 → 0.84                    |
| free    | memory-async | 32    | 4       | 2048 | 2048 → 2048           | 2048 → 2048         | 64 → 64                      | 1.16 → 0.87                    |
| free    | memory-async | 128   | 1       | 512  | 512 → 512             | 512 → 512           | 8 → 8                        | 0.78 → 0.80                    |
| free    | memory-async | 128   | 4       | 2048 | 2048 → 2048           | 2048 → 2048         | 32 → 32                      | 0.81 → 0.83                    |
| free    | redis        | 1     | 1       | 512  | 1.3 → 512             | 1/2 → 512           | 1.3 → 512                    | 7.06 → 49.57                   |
| free    | redis        | 1     | 4       | 2048 | 5 → 2048              | 6/5/4 → 2048        | 5 → 2048                     | 5.85 → 32.19                   |
| free    | redis        | 32    | 1       | 512  | 53.3 → 512            | 32/64 → 512         | 1.7 → 16                     | 5.49 → 8.63                    |
| free    | redis        | 32    | 4       | 2048 | 149.3 → 2048          | 128/192 → 2048      | 4.7 → 64                     | 5.19 → 3.44                    |
| free    | redis        | 128   | 1       | 512  | 106.7 → 512           | 128/64 → 512        | 1.7 → 8                      | 8.78 → 4.44                    |
| free    | redis        | 128   | 4       | 2048 | 298.7 → 2048          | 384/256 → 2048      | 4.7 → 32                     | 5.75 → 2.03                    |
| free    | valkey       | 1     | 1       | 512  | 1.7 → 512             | 1/2 → 512           | 1.7 → 512                    | 5.53 → 41.25                   |
| free    | valkey       | 1     | 4       | 2048 | 6.3 → 2048            | 7/6 → 2048          | 6.3 → 2048                   | 5.23 → 27.90                   |
| free    | valkey       | 32    | 1       | 512  | 64 → 512              | 64/96/32 → 512      | 2 → 16                       | 5.88 → 2.55                    |
| free    | valkey       | 32    | 4       | 2048 | 181.3 → 2048          | 128/192/224 → 2048  | 5.7 → 64                     | 4.99 → 2.83                    |
| free    | valkey       | 128   | 1       | 512  | 149 → 512             | 128/192/127 → 512   | 2.3 → 8                      | 5.13 → 4.26                    |
| free    | valkey       | 128   | 4       | 2048 | 402.7 → 2048          | 448/376/384 → 2048  | 6.3 → 32                     | 4.37 → 2.64                    |
| limited | memory       | 1     | 1       | 512  | 384 → 384             | 256 → 256           | 384 → 384                    | 6.95 → 6.67                    |
| limited | memory       | 1     | 4       | 2048 | 1152 → 1152           | 256 → 256           | 1152 → 1152                  | 6.90 → 6.43                    |
| limited | memory       | 32    | 1       | 512  | 505 → 505             | 256 → 256           | 16 → 16                      | 6.64 → 5.75                    |
| limited | memory       | 32    | 4       | 2048 | 1996 → 1996           | 256 → 256           | 64 → 64                      | 6.84 → 6.17                    |
| limited | memory       | 128   | 1       | 512  | 509 → 509             | 256 → 256           | 8 → 8                        | 5.90 → 5.64                    |
| limited | memory       | 128   | 4       | 2048 | 2024 → 2024           | 256 → 256           | 32 → 32                      | 6.40 → 6.35                    |
| limited | memory-async | 1     | 1       | 512  | 384 → 384             | 256 → 256           | 384 → 384                    | 4.16 → 6.48                    |
| limited | memory-async | 1     | 4       | 2048 | 1152 → 1152           | 256 → 256           | 1152 → 1152                  | 5.88 → 5.74                    |
| limited | memory-async | 32    | 1       | 512  | 505 → 505             | 256 → 256           | 16 → 16                      | 5.36 → 5.78                    |
| limited | memory-async | 32    | 4       | 2048 | 1996 → 1996           | 256 → 256           | 64 → 64                      | 6.09 → 5.93                    |
| limited | memory-async | 128   | 1       | 512  | 509 → 509             | 256 → 256           | 8 → 8                        | 5.68 → 5.64                    |
| limited | memory-async | 128   | 4       | 2048 | 2024 → 2024           | 256 → 256           | 32 → 32                      | 5.88 → 6.06                    |
| limited | redis        | 1     | 1       | 512  | 2.3 → 257             | 1/4/2 → 256         | 2.3 → 257                    | 5.75 → 28.38                   |
| limited | redis        | 1     | 4       | 2048 | 5.3 → 260             | 7/4/5 → 256         | 5.3 → 260                    | 4.49 → 7.73                    |
| limited | redis        | 32    | 1       | 512  | 128 → 309.3           | 64/224/96 → 256     | 4 → 9.7                      | 4.78 → 8.25                    |
| limited | redis        | 32    | 4       | 2048 | 192 → 384             | 160/192/224 → 256   | 6 → 12                       | 4.38 → 5.23                    |
| limited | redis        | 128   | 1       | 512  | 170.7 → 341.3         | 128/256 → 256       | 2.7 → 5.3                    | 5.02 → 6.80                    |
| limited | redis        | 128   | 4       | 2048 | 341.3 → 554.7         | 256 → 256           | 5.3 → 8.7                    | 4.90 → 4.73                    |
| limited | valkey       | 1     | 1       | 512  | 2.3 → 257             | 3/2 → 256           | 2.3 → 257                    | 10.04 → 24.23                  |
| limited | valkey       | 1     | 4       | 2048 | 4.7 → 260             | 6/4 → 256           | 4.7 → 260                    | 4.99 → 10.46                   |
| limited | valkey       | 32    | 1       | 512  | 64 → 288              | 64 → 256            | 2 → 9                        | 5.22 → 9.28                    |
| limited | valkey       | 32    | 4       | 2048 | 170.7 → 384           | 192/128 → 256       | 5.3 → 12                     | 4.21 → 5.36                    |
| limited | valkey       | 128   | 1       | 512  | 128 → 320             | 64/192/128 → 256    | 2 → 5                        | 4.73 → 8.35                    |
| limited | valkey       | 128   | 4       | 2048 | 329.3 → 512           | 256 → 256           | 5.3 → 8                      | 4.13 → 5.48                    |
| scoped  | memory       | 1     | 1       | 512  | 512 → 512             | 257 → 257           | 512 → 512                    | 14.68 → 13.81                  |
| scoped  | memory       | 1     | 4       | 2048 | 2048 → 2048           | 257 → 257           | 2048 → 2048                  | 12.64 → 11.28                  |
| scoped  | memory       | 32    | 1       | 512  | 512 → 512             | 257 → 257           | 16 → 16                      | 6.05 → 6.06                    |
| scoped  | memory       | 32    | 4       | 2048 | 2048 → 2048           | 257 → 257           | 64 → 64                      | 8.16 → 6.80                    |
| scoped  | memory       | 128   | 1       | 512  | 512 → 512             | 257 → 257           | 12 → 12                      | 6.34 → 5.20                    |
| scoped  | memory       | 128   | 4       | 2048 | 2048 → 2048           | 257 → 257           | 37 → 37                      | 8.24 → 6.89                    |
| scoped  | memory-async | 1     | 1       | 512  | 512 → 512             | 257 → 257           | 512 → 512                    | 10.53 → 9.38                   |
| scoped  | memory-async | 1     | 4       | 2048 | 2048 → 2048           | 257 → 257           | 2048 → 2048                  | 11.35 → 9.84                   |
| scoped  | memory-async | 32    | 1       | 512  | 512 → 512             | 257 → 257           | 16 → 16                      | 5.91 → 4.96                    |
| scoped  | memory-async | 32    | 4       | 2048 | 2048 → 2048           | 257 → 257           | 64 → 64                      | 7.62 → 6.13                    |
| scoped  | memory-async | 128   | 1       | 512  | 512 → 512             | 257 → 257           | 12 → 12                      | 5.64 → 4.58                    |
| scoped  | memory-async | 128   | 4       | 2048 | 2048 → 2048           | 257 → 257           | 37 → 37                      | 8.24 → 6.13                    |
| scoped  | redis        | 1     | 1       | 512  | 1.7 → 512             | 1/2 → 257           | 1.7 → 512                    | 10.06 → 73.61                  |
| scoped  | redis        | 1     | 4       | 2048 | 4.7 → 2048            | 1/2 → 257           | 4.7 → 2048                   | 5.91 → 44.56                   |
| scoped  | redis        | 32    | 1       | 512  | 53.3 → 512            | 17/33 → 257         | 1.7 → 16                     | 6.97 → 11.56                   |
| scoped  | redis        | 32    | 4       | 2048 | 149.3 → 2048          | 33/17 → 257         | 4.7 → 64                     | 6.05 → 15.64                   |
| scoped  | redis        | 128   | 1       | 512  | 85.3 → 512            | 33/49 → 257         | 1.7 → 12                     | 7.50 → 21.36                   |
| scoped  | redis        | 128   | 4       | 2048 | 277.3 → 2048          | 33/65 → 257         | 4.3 → 37                     | 6.20 → 11.30                   |
| scoped  | valkey       | 1     | 1       | 512  | 1.7 → 512             | 2/1 → 257           | 1.7 → 512                    | 6.18 → 65.66                   |
| scoped  | valkey       | 1     | 4       | 2048 | 4.7 → 2048            | 1/2 → 257           | 4.7 → 2048                   | 5.32 → 43.44                   |
| scoped  | valkey       | 32    | 1       | 512  | 64 → 512              | 33 → 257            | 2 → 16                       | 6.52 → 11.85                   |
| scoped  | valkey       | 32    | 4       | 2048 | 138.7 → 2048          | 17/33 → 257         | 4.3 → 64                     | 5.60 → 14.44                   |
| scoped  | valkey       | 128   | 1       | 512  | 83 → 512              | 49/33/46 → 257      | 1.7 → 12                     | 7.00 → 15.49                   |
| scoped  | valkey       | 128   | 4       | 2048 | 256 → 2048            | 33 → 257            | 4 → 37                       | 5.89 → 8.02                    |

## Scheduling overhead

The fix adds a `Set.delete` to job cleanup and a counter to each asynchronous
admission. Three alternating before/after pairs (`zero-wait-results/overhead.json`):

| Measure                                                    | Before              | After                |
| ---------------------------------------------------------- | ------------------- | -------------------- |
| `bench/local.ts` valve, 100k jobs, no `maxWait` (ms)       | 100.8 / 95.8 / 97.9 | 100.2 / 97.9 / 102.2 |
| `bench/local.ts` p99 per-start delay (ms)                  | 1.52 / 1.50 / 0.37  | 1.53 / 0.38 / 1.55   |
| zero-wait free memory, 20k jobs, batch 32 (µs/job)         | 1.22 / 1.36 / 1.28  | 1.36 / 1.26 / 1.88   |
| zero-wait free memory-async, 20k jobs, batch 32 (µs/job)   | 1.27 / 1.23 / 1.22  | 1.24 / 1.24 / 1.25   |
| zero-wait scoped memory, 20k jobs, batch 32 (µs/job)       | 6.88 / 7.24 / 7.28  | 9.36 / 6.82 / 7.41   |
| zero-wait scoped memory-async, 20k jobs, batch 32 (µs/job) | 6.19 / 5.84 / 6.60  | 6.68 / 6.20 / 6.26   |

The differences are within run-to-run variation.
