---
name: valve-troubleshooting
description: 'Diagnose valvejs 429s, INVALID_OPTIONS, stalled queues, low throughput, Redis failures, and shutdown hangs. Use when an existing valve integration behaves unexpectedly.'
license: Apache-2.0
---

# Troubleshoot valve

Diagnose from evidence, not by guessing at settings. Most valve problems come
from one of four places: the budget is not actually shared, the rules do not
match the provider, something is paused or waiting on the store, or a call site
bypasses or double-counts the valve.

## Gather evidence first

Before proposing a fix, collect what you can (ask the user for what you cannot
read):

1. Every `createValve` / `createValveGroup` / `redisStore` call: `id`, `rate`,
   `concurrency`, `store`, `maxWait`, `maxQueue`, `onStoreError`, `limits`, and
   where it is created (module scope, or inside a handler or loop).
2. How many processes call the provider with the same credential, and whether
   they all share one Redis server, database, and `prefix`.
3. The exact error: `error.code`, `error.valveId`, `error.message`,
   `error.cause` (`isValveError(error)` tells you it is valve's).
4. `valve.stats()`: `queued`, `running`, `pausedUntil` (epoch ms or `null`),
   and `totals` (`started`, `succeeded`, `failed`, `rejected`, `retried`,
   `storeErrors`).
5. Events: add temporary listeners and reproduce.

   ```ts
   for (const event of [
     'pause',
     'resume',
     'reject',
     'store-error',
     'warning',
     'limits',
   ] as const)
     valve.on(event, (payload) => console.log(valve.id, event, payload));
   ```

6. The provider's response headers on a 429 (`Retry-After`, `RateLimit`,
   `x-ratelimit-*`), and the provider's documented quota.
7. valvejs version (`npm ls valvejs`) and Redis/Valkey version if used.

Then match the symptom below, confirm the cause with the evidence, fix it, and
tell the user how to verify the fix.

## Symptoms

### Still getting 429s

Check in this order:

1. **Budget not shared.** Several processes with the same `id` but no `store`
   (each has a private memory budget), different Redis servers/databases/
   `prefix`, ids that include a pid/hostname/random suffix, or a valve created
   per request or per job. Fix: one `redisStore` per process on the same
   namespace, one valve per quota at module scope, stable ids.
2. **Calls bypass the valve.** Grep for the provider host/SDK; every call must
   go through `run`, `wrap`, or `wrapFetch`. Also other services or scripts
   using the same credential without valve: leave headroom.
3. **Rule looser than the real quota.** Plan-specific limits, a raised `burst`,
   a fixed window where the provider uses a rolling window (fixed windows can
   admit `2 x limit` across a boundary), or a concurrency-only valve with no
   rate rule.
4. **Wrong scope split.** One credential-wide quota split across several ids
   (each gets the full budget).
5. **Feedback not reaching the valve.** With axios/got, 429s throw and the
   `observe` run option never sees them. Map the error to `{ status, headers }`
   and call `valve.observe` in the catch (got uses `statusCode`, not `status`).
   Disable retries inside the client if they bypass per-attempt admission. Custom header names need a custom reader
   (`xRateLimit({ remaining, reset, resetUnit })` from `valvejs/headers`).
6. **Arrival bunching.** Bounds apply when the store grants a start. Network
   jitter or a slow event loop can bunch arrivals; lower the limit slightly or
   use `burst: 1`.
7. **Store state lost.** A flush, restart without persistence, eviction, or
   failover resets budgets silently. Check `maxmemory-policy` (should be
   `noeviction`) and `evicted_keys` in `INFO stats`.

A 429 that still reaches the caller after `wrapFetch` exhausted `retries`
(default 2) is returned as a normal response; that is expected if the provider
keeps refusing.

### Jobs never start, or hang

- **Paused.** `stats().pausedUntil` is set. A large `Retry-After` or
  `x-ratelimit-reset` can pause up to `maxPause` (15m default); look at `pause`
  event `reason` (`feedback`, `backoff`, `store` from another process,
  `manual`). `await valve.resume()` clears it everywhere. If another process
  resumed but this one still waits, there is no `subscriber`; it notices on its
  next store call. Add `subscriber: redis.duplicate()`.
- **Fixed-window exhausted.** A daily `fixed-window` rule waits until the next
  UTC window boundary.
- **Store down.** `store-error` events and `totals.storeErrors` rising. With
  `onStoreError: 'wait'` (default) jobs wait until the store recovers or their
  `maxWait`. Check Redis connectivity and the client's offline queue settings.
- **Global slots held.** With `concurrency: { scope: 'global' }`, crashed
  workers hold slots until `leaseTtl`; long-running jobs hold them while
  running.
- **Nested valves.** `runSequential` or manual nesting holds outer slots while
  inner stages wait; nesting in different orders can deadlock.
- **Waiting forever by design.** No `maxWait` means unbounded waiting. Add one
  so stuck jobs fail with `MAX_WAIT_EXCEEDED`.

### Throughput lower than configured

- GCRA `burst: 1` spaces unit-cost grants by at least `interval / limit` on
  the store's clock. With `limit: 100, interval: '1m'`, that is at least 600ms
  between grants. Callback starts and provider arrivals can bunch after those
  grants. Raise `burst` only if the provider allows bursts.
- Timer lateness accumulates under a saturated GCRA queue; valve never catches
  up by granting closer together.
- Local `concurrency` too low for the call latency (throughput is at most
  `concurrency / latency`).
- Frequent `backoff` pauses from headerless 429s, or `feedback` pauses from
  `remaining: 0` headers: the provider is the bottleneck.
- Cancelled jobs and timed-out store calls spend grants that are not reused.
- Redis latency: each admission is a round trip (up to `batch` jobs, default 32).

### The process does not exit

valve holds timers while jobs are queued or paused. Call `close()` on every
valve and group, then `store.close()` (when using a subscriber), then quit the
Redis clients, including the subscriber. `close({ drain: true })` with
`onStoreError: 'wait'` and no `maxWait` can wait forever during a Redis outage.

## Error codes

| Code                 | Typical cause                                                                                           | Fix                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `INVALID_OPTIONS`    | Bad option at creation (message names it), or Redis reports the id's pinned config differs              | Fix the option; for a mismatch see [references/config-drift.md](references/config-drift.md) |
| `COST_EXCEEDS_LIMIT` | `cost` > a GCRA rule's `burst` (default 1) or > a fixed-window `limit`, possibly after a managed update | Raise `burst` on that rule, or lower `cost`                                                 |
| `QUEUE_FULL`         | `maxQueue` reached; or a group's `maxSize` children are all busy; or group `maxPending` full            | Backpressure (503/retry later), or raise the bound if memory allows                         |
| `MAX_WAIT_EXCEEDED`  | Waited longer than `maxWait` (also `maxWait: 0` without immediate capacity)                             | Expected under load; check for pauses or exhausted windows if constant                      |
| `ABORTED`            | The job's signal aborted while queued                                                                   | Usually expected; `cause` holds `signal.reason`                                             |
| `CLOSED`             | Submitted after or during `close()`                                                                     | Stop intake before closing; filter during shutdown                                          |
| `STORE_UNAVAILABLE`  | Store failed with `onStoreError: 'throw'`, or `getLimits`/`updateLimits` failed                         | Fix Redis; an update's outcome may be unknown, re-read and repeat the absolute patch        |
| `LEASE_LOST`         | Global lease could not be renewed (store outage, event loop stall past `leaseTtl`)                      | Job outcome unknown; make work idempotent; check Redis health and event loop blocking       |
| `LIMITS_CONFLICT`    | `updateLimits` `expect` did not match the current value                                                 | Re-read `getLimits()`, reconcile with the other writer, retry                               |

Errors that are not `ValveError`s come from the user's own function and pass
through unchanged; debug those as normal application errors.

## Redis-specific issues

See [references/redis-diagnostics.md](references/redis-diagnostics.md) for
inspecting keys, timeouts and replayed commands, eviction, cluster, and
subscriber problems.

## Verify the fix

- Unit-level: memory store plus synthetic feedback, for example
  `valve.observe({ status: 429, headers: { 'retry-after': '2' } })` then
  assert `stats().pausedUntil` is set and a queued job waits.
- Shared budget: run two processes against the same Redis with the same id and
  count starts per interval.
- In production: watch `pause` reasons, `store-error`, and `reject` codes.
