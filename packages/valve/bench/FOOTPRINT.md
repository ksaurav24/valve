# Bundle footprint follow-up (#16)

Baseline: `c512c22` (master, after #10 and #17). Current: the changes in this PR.
Host: Linux x64, Intel Core i5-12450H. Sizes use esbuild 0.28.2, browser platform,
ESM, ES2022, bundling, minification, and Node 24.21.0 default gzip compression.
Both variants use identical settings. The issue's historical gzip numbers used a
different compression runtime; compare the paired numbers below.

## Diagnosis and changes

The baseline Redis entry retains 4,497 minified JavaScript bytes from generated
Lua sources and their digests, compared with 2,136 bytes from the store wrapper.
Minifying Lua at build time reduces the generated module to 3,071 bytes. The
readable `.lua` files stay authoritative. The build hashes the exact minified
source used for NOSCRIPT fallback. `luamin` is a pinned development dependency;
the published package still has no runtime or peer dependencies.

A consumer importing only `retryAfter()` retained 1,937 bytes from the headers
module and 683 bytes from its parser. Constructing `defaultFeedback` is free of
external side effects, so pure annotations on the composition and reader
factories let bundlers discard unused readers. The resulting module contributions
are 297 and 461 bytes. The annotations survive the published ESM build.

The core entry is dominated by the scheduler (8,618 minified bytes) and option
normalization (3,171 bytes). The factory returns methods that retain supported
feedback, fetch, and lease behavior. Moving these methods between files would
not make them unreachable to a bundler. A smaller public factory or separate
optional APIs would need a separate compatibility proposal; this PR keeps all
existing exports and behavior.

## Sizes

All values are minified plus gzip bytes. Module breakdowns and uncompressed
sizes are in [baseline.json](footprint-results/baseline.json) and
[current.json](footprint-results/current.json).

| Input                                 | Baseline | Current | Change |
| ------------------------------------- | -------: | ------: | -----: |
| Source core entry (CI measurement)    |    8,361 |   8,361 |      0 |
| Source Redis entry (CI measurement)   |    3,525 |   3,152 | -10.6% |
| Source headers entry (CI measurement) |    1,130 |   1,130 |      0 |
| Published ESM core entry              |    8,358 |   8,358 |      0 |
| Published ESM Redis entry             |    3,521 |   3,151 | -10.5% |
| Published ESM headers entry           |    1,130 |   1,130 |      0 |
| Published ESM createValve consumer    |    8,312 |   8,312 |      0 |
| Published ESM memoryStore consumer    |    1,115 |   1,115 |      0 |
| Published ESM isValveError consumer   |      173 |     173 |      0 |
| Published ESM redisStore consumer     |    3,534 |   3,162 | -10.5% |
| Published ESM retryAfter consumer     |    1,089 |     445 | -59.1% |

CI ceilings remain 8,704 / 4,096 / 2,048 bytes. All pass. Original targets remain
4,096 / 3,072 / 2,048: core and Redis are still unmet; headers passes. This is
the measured disposition of #16: its compatibility, measurement, and existing
ceiling requirements pass, while the original size targets remain unmet. Further
core reduction may require a separate API compatibility proposal, as described
above. The smaller Redis artifact does not establish a scheduler throughput gain.

## Cold import and initialization

Each entry runs in a fresh process. Three alternating baseline/current pairs
contain ten processes per entry per variant, for 30 samples per cell. No samples
are discarded. Filesystem caches are shared. Initialization creates a local valve,
an adapter-backed Redis store without a server connection, or a Retry-After
reader. Closing happens after the measured interval.

Median import / initialization time in milliseconds:

| Node    | Entry   |        Baseline |         Current |
| ------- | ------- | --------------: | --------------: |
| 20.20.2 | core    | 4.4640 / 0.4698 | 4.4369 / 0.4654 |
| 20.20.2 | Redis   | 4.0423 / 0.2232 | 4.0113 / 0.2317 |
| 20.20.2 | headers | 3.9962 / 0.0024 | 3.9995 / 0.0023 |
| 22.23.3 | core    | 2.3853 / 0.4626 | 2.3940 / 0.4693 |
| 22.23.3 | Redis   | 1.7349 / 0.2172 | 1.7341 / 0.2188 |
| 22.23.3 | headers | 1.7282 / 0.0023 | 1.7092 / 0.0023 |
| 24.21.0 | core    | 1.7024 / 0.4826 | 1.7114 / 0.4938 |
| 24.21.0 | Redis   | 0.9868 / 0.2339 | 0.9820 / 0.2386 |
| 24.21.0 | headers | 0.9784 / 0.0022 | 0.9621 / 0.0023 |

These small differences do not establish a startup improvement. Raw samples
retain CPU time, heap delta, RSS, and process peak RSS:
[Node 20](footprint-results/startup-node-20.20.2.json.gz),
[Node 22](footprint-results/startup-node-22.23.3.json.gz),
[Node 24](footprint-results/startup-node-24.21.0.json.gz).
Heap deltas are sensitive to GC and are not allocation counts or peak heap.
Peak RSS includes process startup and is not solely attributable to the import.

## Runtime regression comparisons

Three alternating pairs ran the full 42-case matrix with five measured rounds
each, including all competitor cases. A second set of three alternating pairs
used 50,000 local jobs and 20,000 shared jobs, ten measured rounds, and the
existing 1,000-job warmup. Those longer controls cover local concurrency/rate
cases and both shared-store client families. Bottleneck is retained in the full
matrix; the longer controls retain p-limit and p-queue. No samples were removed.

This shared desktop host shows large changes in unchanged local and competitor
code, as well as store cases. These measurements do not establish a throughput
improvement or clear all runtime regressions. The full matrix and longer
controls are retained below, including slow cases. A fresh-runner CI job runs
the same longer paired controls with a 15% regression gate and uploads every
sample, bundle measurements, and startup measurements.

The five Lua scripts compile to byte-for-byte identical stripped bytecode with
the Lua 5.1 compiler linked to Redis 7.4.7. The checksums and source sizes are
in [lua-bytecode.json](footprint-results/lua-bytecode.json). This confirms
unchanged server VM instructions; it does not replace runtime measurements or
claim identical cold parsing costs.

### Fresh GitHub runner

The [CI run](https://github.com/ksaurav24/valve/actions/runs/37906399378)
tested runtime commit `d46ce4d` on Node 24.21.0, an AMD EPYC 9V45 host, and
Redis 7.4 / Valkey 8 service images. All eighteen longer controls pass the
existing 15% throughput regression gate. Valve throughput changes range from
-2.2% to +7.2%; the two unchanged competitors range from -3.1% to -1.5%.
The desktop host's large throughput changes were not reproduced on this runner.
These results support the footprint change without claiming a runtime speedup.

The [CI summary](footprint-results/ci/summary.json) and all raw samples are
archived in this repository. CPU and per-job logical store calls remain
comparable; each shared-rate control reports 0.03125 calls per job in both
variants. Final-round p99 waits remain variable: local concurrency reports
31.85 / 47.48ms while unchanged p-queue reports 81.64 / 122.60ms. The throughput
gate is not a latency guarantee, and the report retains these values rather than
claiming uniform improvement. No behavior, package, size, or runtime check failed.

CI raw controls:
[0 baseline](footprint-results/ci/control-0-baseline.json.gz),
[0 current](footprint-results/ci/control-0-current.json.gz),
[1 baseline](footprint-results/ci/control-1-baseline.json.gz),
[1 current](footprint-results/ci/control-1-current.json.gz),
[2 baseline](footprint-results/ci/control-2-baseline.json.gz),
[2 current](footprint-results/ci/control-2-current.json.gz).
CI [baseline sizes](footprint-results/ci/baseline-size.json.gz),
[current sizes](footprint-results/ci/current-size.json.gz), and
[startup samples](footprint-results/ci/startup.json.gz) are retained as well.

### Full matrix

Medians pool all elapsed samples (15 per variant in the full matrix, 30 in the
longer controls). Wait and CPU columns are medians of the three reported run
values; each run reports its final measured round for wait percentiles.

| Scenario                       | Library    | Baseline jobs/s | Current jobs/s | Change | p99 wait ms (baseline/current) | CPU ms (baseline/current) |
| ------------------------------ | ---------- | --------------: | -------------: | -----: | -----------------------------: | ------------------------: |
| memory/concurrency             | valve      |         800,580 |        745,309 |  -6.9% |                    9.30 / 9.99 |             28.30 / 30.34 |
| memory/gcra                    | valve      |         962,022 |        951,686 |  -1.1% |                    3.53 / 3.74 |             17.31 / 17.70 |
| memory/fixed-window            | valve      |       1,640,065 |      1,484,722 |  -9.5% |                    3.40 / 4.50 |             13.89 / 12.98 |
| memory/multi-rule              | valve      |       1,620,799 |      1,577,177 |  -2.7% |                    3.79 / 3.87 |             13.20 / 12.34 |
| memory/weighted                | valve      |       1,456,913 |      1,365,690 |  -6.3% |                    4.00 / 3.83 |             18.92 / 15.29 |
| memory/priority                | valve      |       1,100,369 |      1,005,030 |  -8.7% |                    8.33 / 7.85 |             19.53 / 19.41 |
| memory/global-16               | valve      |         345,337 |        343,757 |  -0.5% |                  23.35 / 26.15 |             67.12 / 59.34 |
| memory/concurrency             | p-limit    |       1,373,797 |      1,129,709 | -17.8% |                    4.69 / 6.17 |             14.42 / 15.36 |
| memory/concurrency             | p-queue    |         944,915 |        868,205 |  -8.1% |                    5.02 / 7.45 |             19.85 / 20.31 |
| memory/concurrency             | Bottleneck |             425 |            420 |  -1.1% |            23285.59 / 23324.84 |         1850.60 / 1741.52 |
| async-5ms/concurrency          | valve      |           3,034 |          3,033 |  -0.0% |                162.80 / 161.91 |               3.81 / 5.33 |
| async-5ms/concurrency          | p-limit    |           3,044 |          3,066 |  +0.7% |                163.41 / 161.17 |               3.63 / 3.61 |
| async-5ms/concurrency          | p-queue    |           3,059 |          3,053 |  -0.2% |                161.95 / 159.93 |               9.29 / 4.91 |
| async-5ms/concurrency          | Bottleneck |             423 |            423 |  -0.2% |              1195.09 / 1173.23 |             89.31 / 94.68 |
| paced-100/s                    | valve      |              98 |             98 |  -0.3% |              2022.91 / 2023.91 |             22.10 / 20.59 |
| paced-100/s                    | Bottleneck |             100 |            100 |  +0.1% |              1982.61 / 1981.60 |             70.92 / 64.92 |
| redis/ioredis/gcra             | valve      |         308,429 |        223,269 | -27.6% |                    4.38 / 5.49 |              7.65 / 11.81 |
| redis/ioredis/fixed-window     | valve      |         244,331 |        249,315 |  +2.0% |                    6.44 / 6.14 |             14.25 / 13.79 |
| redis/ioredis/multi-rule       | valve      |         325,862 |        312,501 |  -4.1% |                   17.45 / 6.83 |              13.31 / 4.25 |
| redis/ioredis/weighted         | valve      |         238,153 |        375,928 | +57.9% |                    6.38 / 4.03 |             16.08 / 10.85 |
| redis/ioredis/priority         | valve      |         319,440 |        288,715 |  -9.6% |                    5.82 / 6.24 |               6.65 / 4.86 |
| redis/ioredis/global-16        | valve      |          83,546 |         68,118 | -18.5% |                  11.80 / 14.18 |             13.68 / 13.34 |
| redis/node-redis/gcra          | valve      |         348,759 |        258,506 | -25.9% |                    3.79 / 7.83 |               5.07 / 8.33 |
| redis/node-redis/fixed-window  | valve      |         340,690 |        285,155 | -16.3% |                    5.79 / 6.94 |               6.47 / 8.18 |
| redis/node-redis/multi-rule    | valve      |         432,581 |        291,066 | -32.7% |                    8.97 / 4.58 |               5.95 / 6.26 |
| redis/node-redis/weighted      | valve      |         310,552 |        291,840 |  -6.0% |                    5.39 / 5.10 |               5.04 / 6.02 |
| redis/node-redis/priority      | valve      |         328,319 |        431,172 | +31.3% |                    5.96 / 3.85 |               7.44 / 7.10 |
| redis/node-redis/global-16     | valve      |          70,742 |         77,264 |  +9.2% |                  14.03 / 13.88 |             13.83 / 12.71 |
| redis/global-16                | Bottleneck |           6,280 |          6,041 |  -3.8% |                138.07 / 139.34 |           227.00 / 201.97 |
| valkey/ioredis/gcra            | valve      |         377,967 |        409,309 |  +8.3% |                    3.85 / 3.68 |               7.21 / 3.92 |
| valkey/ioredis/fixed-window    | valve      |         409,020 |        262,544 | -35.8% |                    4.84 / 7.27 |               6.75 / 8.30 |
| valkey/ioredis/multi-rule      | valve      |         418,980 |        268,673 | -35.9% |                   8.02 / 12.43 |               5.72 / 6.21 |
| valkey/ioredis/weighted        | valve      |         488,737 |        417,330 | -14.6% |                    3.60 / 4.49 |               2.28 / 5.57 |
| valkey/ioredis/priority        | valve      |         367,348 |        296,924 | -19.2% |                    8.35 / 4.81 |               7.22 / 5.45 |
| valkey/ioredis/global-16       | valve      |          98,556 |         88,454 | -10.3% |                    9.11 / 8.62 |               9.59 / 6.84 |
| valkey/node-redis/gcra         | valve      |         492,962 |        218,416 | -55.7% |                   3.35 / 12.22 |              5.34 / 23.73 |
| valkey/node-redis/fixed-window | valve      |         384,983 |        308,862 | -19.8% |                    5.55 / 5.25 |               5.67 / 7.82 |
| valkey/node-redis/multi-rule   | valve      |         334,610 |        234,657 | -29.9% |                    4.95 / 7.82 |              7.65 / 10.21 |
| valkey/node-redis/weighted     | valve      |         375,065 |        459,791 | +22.6% |                   4.91 / 10.08 |               6.65 / 5.43 |
| valkey/node-redis/priority     | valve      |         354,770 |        280,824 | -20.8% |                    5.61 / 4.24 |               3.54 / 5.99 |
| valkey/node-redis/global-16    | valve      |          93,701 |         75,982 | -18.9% |                  12.93 / 16.26 |              10.32 / 9.47 |
| valkey/global-16               | Bottleneck |           7,018 |          4,455 | -36.5% |                137.59 / 141.74 |           156.38 / 219.88 |

Raw samples: [0 baseline](footprint-results/comparison-0-baseline.json.gz), [0 current](footprint-results/comparison-0-current.json.gz), [1 baseline](footprint-results/comparison-1-baseline.json.gz), [1 current](footprint-results/comparison-1-current.json.gz), [2 baseline](footprint-results/comparison-2-baseline.json.gz), [2 current](footprint-results/comparison-2-current.json.gz).

### Longer controls

Medians pool all elapsed samples (15 per variant in the full matrix, 30 in the
longer controls). Wait and CPU columns are medians of the three reported run
values; each run reports its final measured round for wait percentiles.

| Scenario                       | Library | Baseline jobs/s | Current jobs/s | Change | p99 wait ms (baseline/current) | CPU ms (baseline/current) |
| ------------------------------ | ------- | --------------: | -------------: | -----: | -----------------------------: | ------------------------: |
| memory/concurrency             | valve   |         619,287 |        971,931 | +56.9% |                  54.85 / 28.99 |           147.23 / 110.33 |
| memory/gcra                    | valve   |         691,138 |      1,060,395 | +53.4% |                  40.27 / 26.64 |            129.31 / 94.85 |
| memory/fixed-window            | valve   |         601,599 |      1,062,513 | +76.6% |                  60.59 / 27.94 |            143.61 / 96.32 |
| memory/multi-rule              | valve   |         655,163 |      1,116,216 | +70.4% |                  52.63 / 29.76 |            138.61 / 91.27 |
| memory/concurrency             | p-limit |         521,654 |        711,362 | +36.4% |                  86.24 / 52.17 |            117.84 / 88.64 |
| memory/concurrency             | p-queue |         556,705 |        604,573 |  +8.6% |                  58.32 / 64.05 |           211.94 / 180.02 |
| redis/ioredis/gcra             | valve   |         133,850 |        252,406 | +88.6% |                 115.59 / 74.03 |            134.81 / 95.89 |
| redis/ioredis/fixed-window     | valve   |         197,970 |        278,743 | +40.8% |                  77.32 / 40.61 |             97.78 / 80.10 |
| redis/ioredis/multi-rule       | valve   |         216,237 |        254,887 | +17.9% |                  53.82 / 89.32 |             70.89 / 64.50 |
| redis/node-redis/gcra          | valve   |         225,205 |        247,910 | +10.1% |                  76.72 / 78.90 |             81.52 / 82.87 |
| redis/node-redis/fixed-window  | valve   |         214,770 |        241,060 | +12.2% |                  91.85 / 90.98 |             88.96 / 78.12 |
| redis/node-redis/multi-rule    | valve   |         202,825 |        225,202 | +11.0% |                  65.91 / 68.22 |             82.02 / 61.17 |
| valkey/ioredis/gcra            | valve   |         391,869 |        266,365 | -32.0% |                  38.51 / 80.61 |             45.04 / 72.37 |
| valkey/ioredis/fixed-window    | valve   |         442,112 |        256,274 | -42.0% |                  37.59 / 64.34 |             46.72 / 68.02 |
| valkey/ioredis/multi-rule      | valve   |         338,808 |        255,692 | -24.5% |                  61.68 / 68.81 |             42.18 / 67.42 |
| valkey/node-redis/gcra         | valve   |         359,537 |        282,054 | -21.6% |                  77.79 / 64.83 |             53.70 / 57.81 |
| valkey/node-redis/fixed-window | valve   |         326,270 |        326,916 |  +0.2% |                  60.96 / 60.35 |             66.85 / 65.01 |
| valkey/node-redis/multi-rule   | valve   |         225,943 |        244,849 |  +8.4% |                  85.92 / 81.11 |             68.66 / 57.03 |

Raw samples: [0 baseline](footprint-results/control-0-baseline.json.gz), [0 current](footprint-results/control-0-current.json.gz), [1 baseline](footprint-results/control-1-baseline.json.gz), [1 current](footprint-results/control-1-current.json.gz), [2 baseline](footprint-results/control-2-baseline.json.gz), [2 current](footprint-results/control-2-current.json.gz).

## Verification

- Full workspace `pnpm check`: lint, types, 183 unit/property tests, coverage,
  declaration tests, builds, source portability, packed-package validation, sizes.
- ESM/CJS and public-subpath smoke checks on Node 20.20.2, 22.23.3, and 24.21.0.
- Redis 7.4.7 and Valkey 8.0.4: 18 integration tests each, including generated
  multi-rule Lua/TypeScript parity, NOSCRIPT fallback, eight-process admission
  bounds, strict paced spacing, shared pauses, global slots, renewal, process
  death, and outage/reconnect policies.
- Redis 7.4.7 Cluster: both client families, hash-tagged keys, shared pauses,
  global leases, and pub/sub (two tests).
- Built documentation: six desktop/mobile browser tests.

The multiprocess harness now minifies its instrumented source and matches the
production minified source/digest. The parity harness replaces the TIME
expression, preserving minified local names. Unit checks verify every generated
digest against its actual script. Runtime Lua algorithms and clocks are unchanged.

## Reproduction

Install dependencies and build the baseline and current worktrees separately.
Run with the same Node executable and host; do not run builds or tests during
timed comparisons.

```sh
node scripts/bundle-footprint.mjs /path/to/baseline baseline.json
node scripts/bundle-footprint.mjs /path/to/current current.json
node scripts/footprint-startup.mjs /path/to/baseline /path/to/current startup.json
```

For runtime regression comparisons, alternate baseline/current order over three
pairs. In each worktree run the complete comparison matrix, keeping competitors:

```sh
REDIS_URL=redis://127.0.0.1:16379 VALKEY_URL=redis://127.0.0.1:16380 \
  VALVE_BENCH_OUT=/path/to/unique-sample.json pnpm bench:compare
```

Default workloads use five measured rounds after warmup, 10,000 local jobs,
2,000 shared-rate jobs, 1,000 shared-lease jobs, 512 callbacks lasting 5ms, and
200 paced jobs. Setup and warmup are excluded. Existing benchmark JSON retains
all elapsed samples, CPU, p50/p99 waits, service p99, peak concurrent jobs,
GC-sensitive heap deltas, logical store calls per job, and paced drift. Logical
store calls are not wire-command counts. These loopback results do not measure
injected network latency, production HTTP throughput, or peak scheduler heap.
