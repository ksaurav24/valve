# Bottleneck Groups and chains

Source: [Migrate from Bottleneck: Groups](https://valvejs.vercel.app/docs/migration/from-bottleneck/#groups)
and [Compose valves](https://valvejs.vercel.app/docs/guides/compose-valves/).

## Decide what the Group or chain was for

| Bottleneck pattern                                         | Intended policy                                         | valve                            |
| ---------------------------------------------------------- | ------------------------------------------------------- | -------------------------------- |
| `Group` per key, each `chain(shared)`                      | Per-key quota **and** a shared parent quota per request | One valve, scoped rules (atomic) |
| `Group` per key, no chain, keys have their own quota/tier  | Independent per-key budgets, queues, cooldowns          | `createValveGroup`               |
| `a.chain(b)` where `a`'s charge should stand if `b` denies | Separate reservations on purpose (ingress, abuse)       | `runSequential` (not atomic)     |
| Several limiters for steps of one workflow                 | Each provider call limited where it happens             | Separate `run` calls per step    |

## Group + chain: scoped rules

Bottleneck chaining reserves on each limiter independently, so a blocked
recipient can hold or waste shared capacity. valve admits a job only when every
applicable budget allows it, and a denied recipient spends nothing:

```ts
// Before
const business = new Bottleneck({ minTime: 100 });
const recipients = new Bottleneck.Group({ minTime: 6000 });
recipients.on('created', (limiter) => limiter.chain(business));
await recipients.key(recipientId).schedule(() => send(recipientId, text));
```

```ts
// After
const messages = createValve({
  id: 'business-42',
  rate: [
    { name: 'business', limit: 1, interval: '100ms' },
    { name: 'recipient', scope: 'recipient', limit: 1, interval: '6s' },
  ],
  store,
});
await messages.run(() => send(recipientId, text), {
  scopes: { recipient: recipientId },
});
```

Trade-offs to tell the user:

- Every job must supply every configured scope (exact keys, nonempty strings up
  to 256 chars). Missing or extra dimensions reject with `INVALID_OPTIONS`.
- Every identity in a rule gets the same limit. Per-key tiers need a group.
- Feedback (429, `Retry-After`, `pause()`) applies to the whole valve id, not to
  one recipient.
- All keys of one valve live in one Redis Cluster slot (atomicity).
- Identities appear in Redis keys: use opaque ids, never phone numbers, emails,
  or tokens; hash with a keyed hash if needed.

Nesting `a.run(() => b.run(fn))` by hand reproduces chaining's independent
reservations; it is not the atomic version.

## Independent Group: createValveGroup

```ts
// Before
const shops = new Bottleneck.Group({
  maxConcurrent: 2,
  minTime: 250,
  timeout: 600_000,
});
await shops.key(shopId).schedule(() => sync(shopId));
```

```ts
// After
import { createValveGroup } from 'valvejs/group';

const shops = createValveGroup({
  id: 'shops',
  store, // shared redisStore for multi-worker budgets; omit for one process
  maxSize: 500,
  idleTtl: '10m', // replaces the Group timeout
  resolve: (shopId) => ({
    rate: { limit: 4, interval: '1s' }, // minTime 250
    concurrency: 2,
  }),
});
await shops.run(shopId, () => sync(shopId));
```

Differences from `Bottleneck.Group`:

- Child ids are `` `${id}:${encodeURIComponent(key)}` ``; workers must agree on
  group id and key mapping. Group id 1 to 198 chars; derived id at most 200.
- `resolve(key)` is synchronous, returns options without `id` or `store`, and
  runs at child creation (again after eviction), not per job. It replaces the
  shared options object plus `on('created')` setup. It must not call back into
  the group.
- `get(key)` returns a member that is safe to keep across eviction (it has
  `run`, `wrap`, `wrapFetch`, `observe`, `pause`, `resume`, `getLimits`,
  `updateLimits`, `stats`). No `key()`, `keys()`, or `deleteKey()`.
- Busy children are never evicted. If all `maxSize` children are busy, a new
  key rejects with `QUEUE_FULL`; treat it as backpressure.
- `group.on(event, (payload, key) => ...)` listens across all children.
- Close the group, then a supplied store, then Redis clients.
- With `limits: 'managed'` and named rules, `group.get(key).updateLimits(...)`
  changes one key's limits across workers (replaces per-key `updateSettings`).

A group does **not** enforce a shared parent quota across keys. If the old
Group was chained to a shared limiter, use scoped rules instead (above).

## Intentional sequential charging: runSequential

```ts
import { runSequential } from 'valvejs';

await runSequential(
  [
    { valve: ingress, options: { cost: 1 } },
    { valve: tenants, options: { scopes: { tenant } } },
  ],
  ({ signal }) => callProvider(signal),
  { signal: AbortSignal.timeout(5000) },
);
```

Equivalent to `ingress.run(() => tenants.run(fn))`. Not atomic: earlier
admissions stay spent when a later stage rejects, times out, aborts, or closes.
Stage ids must differ. The outer stage's concurrency slot and lease stay held
while inner stages wait; nest valves in the same order everywhere to avoid
deadlocks.
