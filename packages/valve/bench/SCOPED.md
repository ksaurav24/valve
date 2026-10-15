# Scoped admission: correctness and performance

This report covers issue #52's v0.4.0 scoped admission implementation. Static
configurations retain prefix admission and the existing Lua script. Scoped
configurations use indexed grants, a delayed eligibility heap, and one bounded
Lua execution per batch. No runtime dependencies were added.

## Measurement protocol

The baseline is commit `83e40e2` (v0.3.0-beta.1). Its built `dist` directory was
saved before implementation. Both variants load their built `dist/index.js`
artifacts; the CI runner builds both checkouts before comparing them. This
replaces the earlier source-versus-build comparison, which was not equivalent.
The final static comparison uses the repository's
paired runner: three alternating cold-process pairs, 100,000 no-op jobs per
throughput sample, and 2,000 paced jobs per timing sample. Every sample is
retained. No tests or builds ran alongside the final measurements. These are
local Node.js v26.8.1 measurements, not estimates of production HTTP throughput.

`scoped-results/static-baseline.json` and `static-current.json` contain the
final raw samples and medians. The separate `pilot-static-*.json` files preserve
a shorter development run with 300 paced jobs; they are not combined with the
final run.

The scoped matrix measures store admission, including identity resolution,
key deduplication, serialization and Redis round trips, but excluding job
execution and request construction. It covers:

- Memory and Redis 7.4.11 on loopback.
- Batch sizes 1, 32 and 128; 2, 8 and 16 rules; 100 calls per scenario.
- Cold identities, one repeated hot identity, and alternating hot/cold jobs.
  Mixed calls alternate over the full job stream, so batch-one workloads also
  exercise both identities. Every scenario checks its expected grant count.
- Up to 12,800 cold identities per scenario, with expiring counters retained
  during measurement to exercise cardinality.
- One, four and eight concurrent Redis clients sharing one Valve ID and slot.

`scoped-results/matrix.json` records evaluated jobs, actual grants, distinct
keys per call, median and p99 call duration, and evaluations per second. A
high rate of denied evaluations is not successful request throughput. The
contention cases use multiple connections from one Node.js process; they do
not model a remote network or a production Redis Cluster's other workloads.

## Results

The matrix was regenerated after correcting the batch-one mixed workload. All
six batch-one mixed cases (two stores x three rule counts) now admit **51 of
100** jobs: one hot identity and 50 distinct cold identities. The earlier
batch-one rows measured only hot jobs and are superseded. The full run includes
54 matrix cases and three contention cases, with every scenario recorded. Matrix
latencies are observations from this run, not a paired comparison between code
revisions. No builds or tests ran alongside it.

The final static medians were **114.27 ms before and 106.22 ms after** for
100,000 jobs. Median p99 per-start delay was **1.382 ms before and 1.312 ms
after**. Both pass the unchanged 15% regression gate. This run found no static
throughput or per-start-delay regression; the small throughput difference does
not establish a general speedup. Accumulated pacing drift remains: median
p99 ideal-sequence delay was 506.32 ms before and 491.78 ms after, so the original
5 ms ideal-sequence target remains unmet.

At the default batch of 32 with two rules:

- Cold recipients: memory median **0.038 ms**, Redis median **0.298 ms**;
  Redis p99 **0.837 ms**, with all 3,200 jobs admitted.
- Mixed recipients: memory median **0.035 ms**, Redis median **0.289 ms**;
  1,601 of 3,200 jobs admitted. Redis evaluated about **95,367 jobs/s**.
- One hot recipient: Redis median **0.236 ms** with only one admission across
  3,200 evaluations. This illustrates why denial speed must not be presented
  as useful throughput.

The largest cold scenario, batch 128 with 16 rules, touched 1,921 unique rate
keys per call. Redis median was **12.46 ms**, p99 **20.83 ms**. Its mixed case
used 976 keys and had a **7.35 ms** median. Large batches with many independent
keys can monopolize a Redis shard for materially longer than the default
workload; the 128-job cap is a maximum, not a recommended default.

For one, four and eight concurrent clients sharing one quota domain, mixed
32-job batches evaluated about **50,041**, **136,932**, and **141,884 jobs/s**.
Median call latency grew from **0.649 ms** to **0.879 ms** to **1.767 ms**.
The extra clients do not remove the hot-slot constraint. These are loopback
client-observed durations, including JavaScript and network overhead, not
isolated Lua CPU timings or Cluster capacity claims.

### Bundle cost

The same source-entry bundling procedure (esbuild 0.28.2, browser ESM,
minification and gzip) measured:

- Core: **8,928 → 11,796 bytes**, an increase of **2,868 bytes**.
- Redis: **3,494 → 6,043 bytes**, an increase of **2,549 bytes**.
- Headers: **1,184 → 1,184 bytes**, unchanged.

`scoped-results/size.json` records those measurements and the CPU model
(Intel Core i5-12450H). Identity validation, the delayed heap, scoped memory
admission and the second Lua script increase the footprint. The old core and
Redis CI ceilings (8,960 and 4,096 bytes) cannot contain this feature. They are
explicitly raised to **12,000 and 6,200 bytes**, with the headers ceiling kept
at 2,048. This is a bundle-size regression, not a footprint improvement. Static
throughput is measured independently; scoped code remains reachable through
the existing factory and store entry points.

The current built-artifact timing run includes the scoped priority fix and
persistent static-policy ownership guard. Current core/Redis sizes are
**11,843 / 6,088 bytes**, still within the existing ceilings. The retained
`size.json` describes the original measurement; these follow-up sizes come
from `pnpm check:size`. The regenerated scoped matrix above does not change
the retained static comparison; no library runtime code changed in the benchmark
correction.

## Correctness checks

The unit suite passes 331 tests with 98.49% line coverage and the existing
coverage thresholds. Integration checks
run against Redis 7, Valkey 8, and a three-master Redis Cluster. Tests cover:

- Exact UTC boundary checks and mixed GCRA bursts/fixed windows use explicit
  expected timelines against both memory and Lua. Real-store expiry checks
  verify expiry timestamps, automatic cleanup, and full recovered capacity.
- All-or-none spending, sparse grants, weighted costs, repeated identities,
  multiple scope dimensions, priority, cancellation, deadlines and shutdown.
- A deterministic memory/Lua comparison over 100 generated workloads, with
  several batches per workload and varying clock advances.
- Shared policy compatibility, collision-free keys, wrong Redis types and
  malformed state rejected before configuration, quota or lease mutation.
- Indexed leases, renewal/release/expiry, four synchronized independent worker processes with unique-identity assertions,
  Cluster slot compatibility, and script-cache recovery.
- Restart/outage policies, reconnect, state loss, and a committed command whose
  result arrives after the client timeout. The timed-out attempt does not run
  under `throw`; its committed reservation remains spent.

Scoped admission is not a durable queue, an exactly-once reservation protocol,
or a provider-arrival guarantee. Feedback remains Valve-wide. Cross-worker
fairness and targeted pause/resume are not included.

## Reproduce

Build a separate baseline checkout at `83e40e2` with the pinned pnpm version,
then run from the implementation checkout:

```sh
pnpm --filter valvejs build
node scripts/paired-benchmarks.mjs \
  /absolute/path/to/baseline/packages/valve/dist/index.js \
  /tmp/static-baseline.json /tmp/static-current.json
node scripts/compare-benchmarks.mjs \
  /tmp/static-baseline.json /tmp/static-current.json

REDIS_URL=redis://127.0.0.1:6379 \
SCOPED_BENCH_OUT=/tmp/scoped-matrix.json \
pnpm --filter valvejs exec tsx bench/scoped.ts

pnpm test:coverage
pnpm test:types
REDIS_URL=redis://127.0.0.1:6379 \
REDIS_CLUSTER_URL=redis://127.0.0.1:17300 \
REDIS_SERVER_BIN=/path/to/redis-server \
pnpm test:integration
REDIS_URL=redis://127.0.0.1:16880 \
pnpm --filter valvejs exec vitest run --config vitest.integration.config.ts \
  test/integration/scoped.integration.test.ts
```

Use `compose.test.yml` for Redis/Valkey and `scripts/cluster-test.sh` for the
local Cluster. Restart tests launch a separate server through
`REDIS_SERVER_BIN`. The benchmark removes only its uniquely prefixed Redis
keys. Keep builds, tests and unrelated load out of timing runs.
