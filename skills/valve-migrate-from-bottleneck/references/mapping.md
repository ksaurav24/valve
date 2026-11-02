# Bottleneck to valve mapping

Source: [Migrate from Bottleneck](https://valvejs.vercel.app/docs/migration/from-bottleneck/).

## Contents

- [Limiter options](#limiter-options)
- [Pacing: minTime](#pacing-mintime)
- [Reservoirs](#reservoirs)
- [Job options](#job-options)
- [Methods](#methods)
- [Events](#events)
- [Clustering](#clustering)
- [Full before and after](#full-before-and-after)

## Limiter options

| Bottleneck                                         | valve                                                          |
| -------------------------------------------------- | -------------------------------------------------------------- |
| `id`                                               | `id` (required, 1 to 200 chars, no `{` or `}`)                 |
| `maxConcurrent` (local)                            | `concurrency: n`                                               |
| `maxConcurrent` (clustered)                        | `concurrency: { limit: n, scope: 'global', leaseTtl?: '30s' }` |
| `minTime: ms`                                      | `rate: { limit: 1, interval: ms }`                             |
| `reservoir` + refresh amount/interval              | `rate: { limit: amount, interval, algorithm: 'fixed-window' }` |
| `reservoir` + increase amount/interval/maximum     | `rate: { limit: amount, interval, burst: maximum }` (GCRA)     |
| `reservoir` alone (a one-time allowance)           | No equivalent; track the allowance in application code         |
| `highWater` + `OVERFLOW`                           | `maxQueue`                                                     |
| `highWater` + `LEAK`, `OVERFLOW_PRIORITY`, `BLOCK` | No equivalent; `maxQueue` always rejects the **new** job       |
| `penalty`                                          | No equivalent                                                  |
| `rejectOnDrop`                                     | Always: valve rejects dropped jobs with a `ValveError`         |
| `trackDoneStatus`                                  | No equivalent; use `stats().totals`                            |
| `datastore`, `clientOptions`, `clusterNodes`       | `store: redisStore({ client })` with your own client           |
| `clearDatastore`                                   | No direct equivalent; follow the quota migration procedure     |
| `timeout` (Redis key TTL)                          | Not needed                                                     |
| `Promise`                                          | Not supported; native promises                                 |
| `Bottleneck.Batcher`                               | No equivalent; batch in application code, then `run` the batch |

Bottleneck with neither `minTime` nor a reservoir and only `maxConcurrent` maps
to a concurrency-only valve (`concurrency: n`, no `rate`). That does not space
requests; add a rate rule if the provider has a rate limit.

## Pacing: minTime

```ts
// Bottleneck: { minTime: 250 }
rate: { limit: 1, interval: 250 }
// Same admission rule, readable as a rate:
rate: { limit: 4, interval: '1s' }
```

GCRA with `burst: 1` expresses a similar pacing intention at admission, while
Bottleneck's `minTime` spaces scheduled starts. Unit-cost Valve grants are at
least `interval / limit` apart on the store's clock. Store-reply and scheduling
delays can bunch callback starts; neither setting guarantees request-arrival
spacing at the provider. If `minTime` did not divide evenly (`minTime: 333`),
prefer the provider's real figure (`{ limit: 3, interval: '1s' }`).

## Reservoirs

Refresh (resets to N every interval) is a fixed window:

```ts
// { reservoir: 100, reservoirRefreshAmount: 100, reservoirRefreshInterval: 60_000 }
rate: { limit: 100, interval: '1m', algorithm: 'fixed-window' }
```

Difference: Bottleneck's interval starts at limiter creation; valve windows
align to the store's epoch clock, so every worker agrees on boundaries (a `1m`
window resets on UTC minute boundaries, `24h` at UTC midnight).

Refresh plus `minTime` to avoid a flood at the boundary becomes two rules:

```ts
rate: [
  { limit: 100, interval: '1m', algorithm: 'fixed-window' },
  { limit: 5, interval: '1s' },
];
```

Increase (grows by N per interval up to a maximum) can be approximated by GCRA
with `burst` and smooth refill. This changes discrete refill timing and starts
with a full burst; a lower initial reservoir is not preserved automatically:

```ts
// { reservoir: 40, reservoirIncreaseAmount: 2, reservoirIncreaseInterval: 1000, reservoirIncreaseMaximum: 40 }
rate: { limit: 2, interval: '1s', burst: 40 }
```

Unnamed rules with the same algorithm and interval are rejected; add `name`s if
two rules collide.

## Job options

| Bottleneck       | valve                                                                                                    |
| ---------------- | -------------------------------------------------------------------------------------------------------- |
| `priority` (0-9) | `priority: 5 - p` (any integer, higher first, default 0)                                                 |
| `weight`         | `cost` (spent from every rule; concurrency counts 1 per job)                                             |
| `expiration`     | Explicit cooperative timeout with `AbortSignal.timeout`; lease TTL is crash recovery, not a run deadline |
| `id`             | Not needed; errors carry `valveId`                                                                       |

`cost` must fit: GCRA `cost <= burst`, fixed-window `cost <= limit`.
Bottleneck weight also consumes concurrency slots; valve counts one slot per
job, so weighted in-flight limits need a separate design. With minTime alone,
charging weight as cost can change pacing; map the provider quota, not just
the option name.

## Methods

| Bottleneck                               | valve                                                                                                |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `schedule(fn, ...args)`                  | `run(() => fn(...args))`                                                                             |
| `schedule(options, fn, ...args)`         | `run(() => fn(...args), options)`                                                                    |
| `wrap(fn)`                               | `wrap(fn)`                                                                                           |
| `wrapped.withOptions(options, ...args)`  | Translate priority, weight and expiration before passing valve options                               |
| `submit(fn, ...args, cb)`                | `run`, or `util.callbackify`                                                                         |
| `stop({ dropWaitingJobs: true })`        | `close()`                                                                                            |
| `stop({ dropWaitingJobs: false })`       | `close({ drain: true })`                                                                             |
| `counts()`, `queued()`, `running()`      | `stats()`                                                                                            |
| `empty()`                                | `stats().queued === 0`                                                                               |
| awaiting `idle`                          | `await valve.idle()` or `on('idle')`                                                                 |
| `updateSettings(options)`                | `updateLimits` for managed numeric `limit`/`burst`; other changes need the quota migration procedure |
| `incrementReservoir`, `currentReservoir` | No equivalent                                                                                        |
| `jobStatus(id)`, `jobs(status)`          | No equivalent                                                                                        |
| `ready()`, `disconnect()`                | Connect your client before `redisStore`; `close()` valves, then quit the client                      |
| `chain(limiter)`                         | Scoped rules (atomic) or `runSequential` (not atomic)                                                |

Never write `run(fn)` when `fn` expects its own arguments: valve passes
`{ signal }` as the first argument.

## Events

| Bottleneck                | valve                                                                     |
| ------------------------- | ------------------------------------------------------------------------- |
| `error`                   | `store-error` for store failures, `warning` for listener errors           |
| `failed`                  | Catch the rejection from `run`                                            |
| `retry`                   | `stats().totals.retried`                                                  |
| `idle`                    | `idle`                                                                    |
| `empty`                   | No equivalent                                                             |
| `dropped`                 | `reject` with code `QUEUE_FULL`                                           |
| `depleted`                | No equivalent; `pause` fires when the provider reports no remaining quota |
| `debug`, lifecycle events | No equivalent                                                             |

Retry handlers (`on('failed', () => delayMs)`): use `wrapFetch(fetch, { retries })`
for 429s and 503s with `Retry-After`; anything else retries outside valve.

## Clustering

| Bottleneck                                       | valve                                                                               |
| ------------------------------------------------ | ----------------------------------------------------------------------------------- |
| First limiter stores settings in Redis           | Each worker passes config; Redis pins it and rejects mismatches (`INVALID_OPTIONS`) |
| `maxConcurrent` is cluster-wide                  | `concurrency: n` is per process; `scope: 'global'` for cluster-wide                 |
| `expiration` so crashed workers release slots    | Leases expire after `leaseTtl`                                                      |
| Priorities, queue order, `highWater` per limiter | Same: queues are local                                                              |
| `idle` waits for jobs anywhere in the cluster    | `idle` is local to the process                                                      |
| Bottleneck creates the connection                | You create, connect, and close the client                                           |
| Client clocks                                    | Redis server `TIME`                                                                 |

```ts
import { Redis } from 'ioredis';
import { redisStore } from 'valvejs/redis';

const redis = new Redis({
  host: '127.0.0.1',
  port: 6379,
  enableOfflineQueue: false,
});
export const store = redisStore({ client: redis });
```

node-redis: `await createClient({ url }).connect()` first. Redis 6.2+ or
Valkey 7.2+, `maxmemory-policy noeviction` recommended. Optional
`subscriber: redis.duplicate()` gives immediate cross-process wakeups.

## Full before and after

```ts
// Before
import Bottleneck from 'bottleneck';

const limiter = new Bottleneck({
  id: 'hubspot',
  maxConcurrent: 5,
  minTime: 100,
  datastore: 'ioredis',
  clientOptions: { host: '127.0.0.1', port: 6379 },
});
const contact = await limiter.schedule({ priority: 1 }, getContact, '123');
```

```ts
// After
import { Redis } from 'ioredis';
import { createValve } from 'valvejs';
import { redisStore } from 'valvejs/redis';

const redis = new Redis({
  host: '127.0.0.1',
  port: 6379,
  enableOfflineQueue: false,
});
const hubspot = createValve({
  id: 'hubspot',
  rate: { limit: 1, interval: 100 },
  concurrency: { limit: 5, scope: 'global' },
  store: redisStore({ client: redis }),
});
const contact = await hubspot.run(() => getContact('123'), { priority: 4 });
```
