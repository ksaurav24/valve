# Scoped admission: correctness and performance

This report covers issue #52's v0.4.0 scoped admission implementation. Static
configurations retain prefix admission and the existing Lua script. Scoped
configurations use indexed grants, a delayed eligibility heap, and one bounded
Lua execution per batch. No runtime dependencies were added.

## Measurement protocol

The baseline is commit `83e40e2` (v0.3.0-beta.1). Its built `dist` directory was
saved before implementation. The final static comparison uses the repository's
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
- Up to 12,800 cold identities per scenario, with expiring counters retained
  during measurement to exercise cardinality.
- One, four and eight concurrent Redis clients sharing one Valve ID and slot.

`scoped-results/matrix.json` records evaluated jobs, actual grants, distinct
keys per call, median and p99 call duration, and evaluations per second. A
high rate of denied evaluations is not successful request throughput. The
contention cases use multiple connections from one Node.js process; they do
not model a remote network or a production Redis Cluster's other workloads.

## Results

The final static medians were **106.51 ms before and 101.32 ms after** for
100,000 jobs. Median p99 per-start delay was **1.457 ms before and 1.154 ms
after**. Both pass the unchanged 15% regression gate. This run found no static
throughput or per-start-delay regression; the small throughput difference does
not establish a general speedup. Accumulated pacing drift remains: median
p99 ideal-sequence delay was 560.72 ms before and 482.82 ms after, so the original
5 ms ideal-sequence target remains unmet.

At the default batch of 32 with two rules:

- Cold recipients: memory median **0.039 ms**, Redis median **0.322 ms**;
  Redis p99 **0.907 ms**, with all 3,200 jobs admitted.
- Mixed recipients: memory median **0.034 ms**, Redis median **0.267 ms**;
  1,601 of 3,200 jobs admitted. Redis evaluated about **117,479 jobs/s**.
- One hot recipient: Redis median **0.164 ms** with only one admission across
  3,200 evaluations. This illustrates why denial speed must not be presented
  as useful throughput.

The largest cold scenario, batch 128 with 16 rules, touched 1,921 unique rate
keys per call. Redis median was **12.38 ms**, p99 **16.97 ms**. Its mixed case
used 976 keys and had a **6.83 ms** median. Large batches with many independent
keys can monopolize a Redis shard for materially longer than the default
workload; the 128-job cap is a maximum, not a recommended default.

For one, four and eight concurrent clients sharing one quota domain, mixed
32-job batches evaluated about **93,517**, **139,198**, and **142,100 jobs/s**.
Median call latency grew from **0.295 ms** to **0.855 ms** to **1.733 ms**.
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

The timing run preceded a final scoped-only priority fix that promotes overdue
delayed jobs in bounded batches before selection. That fix does not change the
static admission branch or the store-only matrix workloads. Bundle measurements
include the fix.

## Correctness checks

The unit suite passes 326 tests with 98.32% line coverage and the existing
coverage thresholds. Integration checks
run against Redis 7, Valkey 8, and a three-master Redis Cluster. Tests cover:

- All-or-none spending, sparse grants, weighted costs, repeated identities,
  multiple scope dimensions, priority, cancellation, deadlines and shutdown.
- A deterministic memory/Lua comparison over 100 generated workloads, with
  several batches per workload and varying clock advances.
- Shared policy compatibility, collision-free keys, wrong Redis types and
  malformed state rejected before configuration, quota or lease mutation.
- Indexed leases, renewal/release/expiry, four independent worker processes,
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
