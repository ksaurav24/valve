---
name: valve-migrate-from-bottleneck
description: 'Migrate Bottleneck limiters, reservoirs, scheduling, groups, chains, and Redis clustering to valvejs. Use when replacing Bottleneck with valve or translating a Bottleneck option or call into valve semantics.'
license: Apache-2.0
---

# Migrate from Bottleneck to valve

valve and Bottleneck both queue jobs in-process and can share limits through
Redis, but there is **no compatibility layer**. Each limiter has to be
translated on purpose, because several Bottleneck concepts change meaning:

- Priority is inverted: Bottleneck runs **lower** numbers first (default 5),
  valve runs **higher** numbers first (default 0).
- `run(fn)` calls `fn({ signal })`, not `fn(...args)` like `schedule(fn, ...args)`.
- Reservoir refresh intervals start at limiter creation in Bottleneck; valve
  fixed windows align to the store's epoch clock (UTC).
- Clustered `maxConcurrent` is fleet-wide in Bottleneck; valve's numeric
  `concurrency` is per process, `{ scope: 'global' }` is fleet-wide.
- Bottleneck stores settings in Redis from the first limiter; valve workers each
  pass their own config, and Redis pins and checks it.
- `chain()` makes independent reservations; valve can spend several budgets
  atomically with scoped rules.

## Workflow

### 1. Inventory every limiter

Search for `bottleneck`, `new Bottleneck`, `Bottleneck.Group`, `.chain(`,
`.schedule(`, `.submit(`, `.wrap(`, `.updateSettings(`, `.incrementReservoir(`,
`.on('failed'`, `datastore:`. For each limiter record: options, Redis/cluster
settings, which call sites use it, job options (priority, weight, expiration,
id), event handlers, and whether it is a Group or chained.

Ask (or infer from code and comments) what provider quota each limiter was
modeling. Bottleneck configs are often approximations (`minTime: 334` for
"3 per second"); valve can usually express the real quota directly.

### 2. Translate limiter options

Core mappings (full table, edge cases and examples in
[references/mapping.md](references/mapping.md)):

| Bottleneck                                                          | valve                                                                   |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `id`                                                                | `id` (required; 1 to 200 chars, no `{` `}`)                             |
| `minTime: ms`                                                       | `rate: { limit: 1, interval: ms }` or the per-second form               |
| `maxConcurrent` (local)                                             | `concurrency: n`                                                        |
| `maxConcurrent` (clustered)                                         | `concurrency: { limit: n, scope: 'global' }`                            |
| `reservoir` + `reservoirRefreshAmount` + `reservoirRefreshInterval` | `{ limit: amount, interval, algorithm: 'fixed-window' }`                |
| `reservoir` + `reservoirIncrease*` with `reservoirIncreaseMaximum`  | `{ limit: increaseAmount, interval: increaseInterval, burst: maximum }` |
| `highWater` + `strategy: OVERFLOW`                                  | `maxQueue` (rejects the new job with `QUEUE_FULL`)                      |
| `datastore`, `clientOptions`, `clusterNodes`                        | `store: redisStore({ client })` with a client you create                |
| `timeout` (Redis key TTL)                                           | Not needed; keys expire on their own                                    |

Reservoir mappings change timing: fixed windows reset on epoch boundaries;
GCRA refills smoothly and starts with a full burst, rather than preserving an
arbitrary initial reservoir. These are policy translations, not exact emulation.

Combine pacing and windows as several rules in one array; each job spends from
all of them atomically. When `minTime` was added to soften a reservoir refresh
flood, keep both as two rules.

### 3. Rewrite call sites

| Bottleneck                                                    | valve                                                                                         |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `limiter.schedule(fn, a, b)`                                  | `valve.run(() => fn(a, b))`                                                                   |
| `limiter.schedule({ priority: p, weight: w }, fn, a)`         | `valve.run(() => fn(a), { priority: 5 - p, cost: w })`                                        |
| `limiter.wrap(fn)`                                            | `valve.wrap(fn)`                                                                              |
| `wrapped.withOptions(opts, a)`                                | Translate job options first, then `run` or `wrap`                                             |
| `limiter.submit(fn, a, cb)`                                   | No callback API: `run`, or `util.callbackify`                                                 |
| `limiter.stop({ dropWaitingJobs })`                           | `close()` (drop) / `close({ drain: true })` (keep)                                            |
| `counts()`, `queued()`, `running()`                           | `stats()` (`queued`, `running`, `totals`)                                                     |
| `empty()`                                                     | `stats().queued === 0`                                                                        |
| `updateSettings(...)`                                         | `limits: 'managed'` + `updateLimits` for `limit`/`burst`; anything else is a policy migration |
| `incrementReservoir`, `currentReservoir`, `jobStatus`, `jobs` | No equivalent; redesign or drop                                                               |
| `chain(other)`                                                | Scoped rules (atomic) or `runSequential` (not atomic)                                         |
| `Bottleneck.Group`                                            | Scoped rules, or `createValveGroup` from `valvejs/group`                                      |

Convert priorities with `valvePriority = 5 - bottleneckPriority`, which keeps
order and maps the default 5 to 0. Bottleneck `weight` becomes `cost`; under
GCRA every cost must be `<= burst` (default 1) or it rejects with
`COST_EXCEEDS_LIMIT`. Choose a burst that fits the largest cost only when the
provider permits that capacity. Bottleneck weight also occupies that many
`maxConcurrent` slots; valve concurrency counts one job regardless of `cost`.
If weighted in-flight capacity matters, retain an application-level weighted
semaphore or redesign it explicitly. Mapping weight to cost can also change
`minTime`-only pacing; confirm whether the provider charges weighted requests.

`expiration` had two jobs. Crash recovery is automatic with global leases
(`leaseTtl`). Execution timeouts become the callback's responsibility:

```ts
await api.run(({ signal }) => {
  const timeout = AbortSignal.timeout(10_000);
  return fetch(url, {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
});
```

`maxWait` is different: it bounds time in the queue, not running time.

### 4. Groups and chains

Decide per case, using [references/groups-and-chains.md](references/groups-and-chains.md):

- `Group` + `chain(shared)` (per-key limiter feeding a shared limiter, the
  classic "per recipient and per account" pattern) usually becomes **one valve
  with scoped rules**: atomic, so a blocked key spends no shared budget.
- `Group` with independent per-key quotas or tiers and no shared parent becomes
  **`createValveGroup`** (`resolve(key)` returns per-key options; idle keys are
  evicted automatically; `idleTtl` replaces the group `timeout`).
- A chain where charging the first limiter even if the second denies is
  intended becomes **`runSequential`**, stated explicitly as non-atomic.

### 5. Redis

Bottleneck created connections from `clientOptions`. With valve, create and
connect the client yourself (ioredis or node-redis), pass it to
`redisStore({ client })` once per process, and close it after the valves. Every
worker must use the same `id`, store namespace (`prefix`), and identical rules.
Redis 6.2+ or Valkey 7.2+. See [references/mapping.md](references/mapping.md#clustering).

### 6. Retries and events

- Retry handlers in `limiter.on('failed', ...)` that retried rate-limit
  failures become `wrapFetch` (retries 429 and 503 with `Retry-After` after a
  shared pause, for idempotent methods, `retries: 2` by default). Retries for
  other failures move to the caller, a retry library, or the job queue.
- Events: `error` to `store-error` (and `warning`); `failed` to the rejected
  promise; `idle` to `idle` or `valve.idle()`; `dropped` to `reject` with code
  `QUEUE_FULL`; `retry` to `stats().totals.retried`; `depleted`, `empty`,
  `debug` have no equivalent (`pause` fires when the provider reports no
  remaining quota).

### 7. Plan the rollout

The two libraries keep separate state. Running Bottleneck and valve against the
same credential at once gives each a full budget, so the provider sees up to
double. Write a rollout note for the user:

1. Deploy valve behind the same call sites, but cut over all workers for a
   credential together (feature flag or a single deploy).
2. Stop producers or drain old Bottleneck workers (`stop({ dropWaitingJobs: false })`)
   before valve workers start admitting for that credential, and let the
   provider quota recover.
3. Starting valve with a fresh id does not transfer Bottleneck's reservations.
4. Remove `bottleneck` from dependencies and delete leftover Bottleneck Redis
   keys only after no old worker can run (`b_<id>*` keys under its namespace).

### 8. Verify

Typecheck, run tests, and check that no `bottleneck` import remains. Add a test
that a priority-ordered or weighted call still behaves as intended. Summarize
for the user each limiter's old config, new config, and any behavior change
(priority inversion handled, window alignment, lost features).

## What the user gains

Provider header feedback that pauses every worker, several rules checked
atomically, cancellation and queue deadlines (`signal`, `maxWait`), typed error
codes, no bundled Redis client. Point them to
<https://valvejs.vercel.app/docs/migration/from-bottleneck/> for the full guide.
