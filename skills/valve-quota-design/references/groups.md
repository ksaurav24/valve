# Independent keyed groups

Source: [Independent keyed groups](https://valvejs.vercel.app/docs/guides/independent-groups/)
and the [API reference](https://valvejs.vercel.app/docs/reference/api/#createvalvegroup).

Use when each tenant, customer credential, or model has its own quota, tier,
concurrency, or cooldown, and there is no shared parent quota that a request
must also spend.

## Example: tiers per tenant, shared across workers

```ts
import { Redis } from 'ioredis';
import { isValveError } from 'valvejs';
import { createValveGroup } from 'valvejs/group';
import { redisStore } from 'valvejs/redis';

const redis = new Redis(process.env.REDIS_URL!, { enableOfflineQueue: false });
const store = redisStore({ client: redis });

const tiers = await loadTiers(); // Load before use; resolve must be synchronous.
const tierFor = (tenant: string) =>
  tiers.get(tenant) ?? { limit: 5, concurrency: 1 };

export const tenants = createValveGroup({
  id: 'crm:tenants',
  store,
  maxSize: 500, // live local children, busy and idle
  idleTtl: '10m',
  resolve: (tenant) => {
    const tier = tierFor(tenant);
    return {
      rate: { name: 'tenant', limit: tier.limit, interval: '1s' },
      concurrency: tier.concurrency,
      maxQueue: 100,
      maxWait: '10s',
      limits: 'managed', // optional: per-key runtime updates
    };
  },
});

export async function syncForTenant(tenant: string) {
  try {
    return await tenants.run(tenant, ({ signal }) => callCrm(tenant, signal));
  } catch (error) {
    if (isValveError(error, 'QUEUE_FULL')) return 'busy'; // capacity or per-key queue
    throw error;
  }
}

// Shutdown: group, then store, then client.
await tenants.close({ drain: true });
await store.close();
await redis.quit();
```

## Rules for `resolve`

- Synchronous. A promise, or a result containing `id` or `store`, rejects with
  `INVALID_OPTIONS`. It must not call back into the same group.
- Runs on first local use of a key and again after eviction, never per job.
  Options are copied; later mutation has no effect.
- Every worker must resolve the same rule structure for a key. Immutable
  mismatches reject with `INVALID_OPTIONS`. In managed mode numeric values only
  seed unknown keys; stored values stay authoritative, so changing the tier
  lookup does not update existing keys. Use `updateLimits` for that.

## Members

`group.get(key)` validates the key and returns a member without creating a
child. Members are safe to keep across eviction and expose `run`, `wrap`,
`wrapFetch`, `observe`, `pause`, `resume`, `getLimits`, `updateLimits`,
`stats()` (undefined when no local child), `key`, `id`.

```ts
const tenantFetch = tenants.get('tenant-42').wrapFetch(); // feedback on this key only
```

Don't wrap the same request in both `group.run(key, ...)` and the member's
`wrapFetch`; it would admit twice.

`group.on('pause', (event, key) => ...)` listens across current and future
children.

## Ids and keys

Child id is exactly `` `${groupId}:${encodeURIComponent(key)}` ``. Group id 1 to
198 chars without braces; the derived child id must fit 200 chars. Hash long
keys (`createHash('sha256').update(id).digest('hex')`, or a keyed HMAC for
sensitive values) with the same scheme on every worker. Moving from hand-built
ids `crm:tenants:${tenant}` keeps store state for keys that need no encoding.

## Capacity and lifecycle

- At capacity, the least recently used idle child is evicted (unpaused first).
  Busy children are never evicted. If all are busy, a call for a new key
  rejects with `QUEUE_FULL`: apply upstream backpressure, don't spin.
- `maxPending` (default 1000) bounds calls waiting for a closing child.
- Eviction frees local memory only; budgets, pauses, managed limits survive in
  the store. Local stats and backoff counters reset.
- `getLimits`/`updateLimits` on a key without a child need a cache slot; keep
  headroom in `maxSize` if updates must succeed under saturation.
- `close()` rejects queued jobs; `close({ drain: true })` runs them. Calls
  still waiting for a closing child reject with `CLOSED` either way.
- A group never closes a supplied store.

## What a group is not

No shared parent quota across keys, no atomic admission across keys, no
cross-worker fairness. For a hard parent plus per-key quota on the same
request, use one valve with scoped rules.
