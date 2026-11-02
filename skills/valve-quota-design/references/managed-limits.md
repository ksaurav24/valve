# Managed limits: change limits at runtime

Source: [Update limits at runtime](https://valvejs.vercel.app/docs/guides/runtime-limits/).

Opt in with `limits: 'managed'`. The store becomes authoritative for each named
rule's `limit` and GCRA `burst`. Names, scopes, algorithms, intervals, and
global concurrency stay fixed (structural).

```ts
const api = createValve({
  id: 'partner:credential-42',
  limits: 'managed',
  rate: [
    { name: 'second', limit: 100, interval: '1s', burst: 10 }, // seeds
    { name: 'day', limit: 100_000, interval: '24h', algorithm: 'fixed-window' },
  ],
  store: redisStore({ client: redis, subscriber }),
});
```

- Every rule needs a unique `name`; at least one rate rule is required.
- Configured numbers are **seeds** for a new id only. Once registered, stored
  values win even if another worker starts with different seeds (it emits a
  `warning`).
- Built-in memory and Redis stores support it.

## Read and update

```ts
const current = await api.getLimits(); // registers seeds if absent
const next = await api.updateLimits(
  { second: { limit: 250, burst: 20 } }, // absolute values, not increments
  { expect: { second: { limit: current.rules.second.limit } } }, // compare-and-set
);
```

- Omitted rules and fields stay unchanged. A no-op returns the same version.
- Without `expect`, the same field is last-writer-wins. With it, a mismatch
  rejects `LIMITS_CONFLICT` and changes nothing; an expected field already equal
  to the patched value passes, so repeating the same update is safe.
- `STORE_UNAVAILABLE` (timeout) means the outcome is unknown; repeat the same
  absolute patch or re-read.
- Invalid patches (unknown rule or field, non-positive or unsafe integers,
  `burst` on fixed-window, immutable valve) reject `INVALID_OPTIONS`.
- `version` is opaque; `revision` restarts after state loss.

## Semantics

- Admission reads committed values in the same atomic store operation.
- Fixed window keeps its count and alignment; lowering below the spent count
  blocks until the next window.
- GCRA keeps debt in cost units and drains it at the new rate. Changing `burst`
  changes capacity, not existing debt.
- Updates do not revoke granted or running work; queued jobs see new values at
  their next admission.
- Scoped rules: one patch changes the value for every identity. Redis migrates
  identities lazily; after a rate **decrease**, an identity untouched before its
  old expiry is treated as recovered at that time (bounded cold-identity
  forgiveness).
- Groups: `group.get(key).updateLimits(...)` updates one key across workers;
  survives eviction.

## Propagation and monitoring

- The updating process wakes immediately; a relaxing change wakes others via
  the subscriber (with jitter). Restrictive changes need no wake, since every
  admission reads authoritative values. As a backstop, a valve waiting longer
  than a second re-reads limits about every second without a subscriber, or
  every 10 seconds with one.
- `limits` event: this process saw a new version (not a fleet ack).
- Alert on `warning` about a new registration epoch or a version moving
  backwards: state was lost or restored; re-apply intended values with
  `expect`.

## Deploy safely

- Requires `maxmemory-policy noeviction`, persistence, and failover monitoring.
- Immutable and managed workers can share an id only while no managed update
  has committed and their rules are identical. Drain every immutable worker
  before the first `updateLimits`; afterwards immutable workers reject with
  `INVALID_OPTIONS`. Requires valvejs 0.4.0+ everywhere.
- Never delete Redis keys to apply an update.
