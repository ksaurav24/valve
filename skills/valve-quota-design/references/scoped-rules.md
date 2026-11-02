# Scoped rules: one atomic admission across shared and per-key budgets

Source: [Scoped rate limits](https://valvejs.vercel.app/docs/guides/scoped-rate-limits/).
Requires the built-in memory or Redis store (or a custom store with
`acquireScoped`).

## Define

```ts
import { createValve } from 'valvejs';

const messages = createValve({
  id: 'messaging:business-123',
  rate: [
    { name: 'throughput', limit: 80, interval: '1s', burst: 8 }, // whole id
    { name: 'spacing', scope: 'recipient', limit: 1, interval: '6s' }, // per recipient
    {
      name: 'daily',
      scope: 'recipient',
      limit: 100,
      interval: '24h',
      algorithm: 'fixed-window', // resets at UTC midnight
    },
  ],
  maxQueue: 1000,
  maxWait: '30s',
  store, // redisStore for multiple workers
});

await messages.run(() => send(contactId, text), {
  scopes: { recipient: contactId },
});
```

A rule without `scope` applies to the whole valve id. Rules sharing a scope
dimension use the same identity but separate counters (by name).

## Identities

- Every job must pass **exactly** the configured dimensions as own properties of
  `scopes`. Missing or extra dimensions, empty strings, strings over 256 UTF-16
  code units, or invalid Unicode reject with `INVALID_OPTIONS` before queueing.
- No optional or conditional rules; don't use placeholder identities to skip a
  rule.
- Use stable opaque application ids. Redis keys encode identity values but do
  not anonymize them: never phone numbers, emails, tokens. Use a keyed hash with
  the same key on every worker if needed. Changing the mapping creates fresh
  budgets.
- Dimensions are independent: `{ tenant: 't7', recipient: 'c42' }` shares
  recipient `c42` across all tenants. If recipients are tenant-local, pass a
  combined opaque id for the pair.

## With wrappers

```ts
const getContact = messages.wrap((url: string) => fetch(url), {
  scopes: { recipient: 'contact-42' },
});

const limitedFetch = messages.wrapFetch(fetch, {
  scopes: (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const recipient = url.searchParams.get('contactId');
    if (!recipient) throw new Error('contactId is required');
    return { recipient };
  },
});
```

The resolver is synchronous, runs once per logical request, and its result is
reused across retries; each retry spends every budget again.

## Behavior

- Atomic: all applicable budgets spend together, or none. A blocked recipient
  does not hold or waste shared throughput.
- Queue order: higher priority first among ready jobs; a blocked identity does
  not block others (no strict FIFO across identities). A high-cost denial does
  not stop a lower-cost job from being considered.
- Feedback and pauses apply to the whole id (all recipients). There is no
  per-scope pause. A scoped rate denial does not emit a `pause` event.
- Every identity in a rule shares the same `limit`/`burst` (managed limits can
  change that shared value, not per identity).
- Inactive identities expire automatically; never delete their keys manually.

## Limits and operations

- At most 16 rules; `batch` at most 128, default 32. Start at 32; try 8 or 16
  if Redis shard latency matters. 128 jobs x 16 rules is a safety bound, not a
  recommendation (it can run long Lua scripts on one shard).
- All keys for one valve share a Redis Cluster slot. A hot business is a hot
  slot; the budget cannot be spread across shards.
- Adding, renaming, or removing a rule or dimension is a policy change (see
  changing-policy.md): all producers must start supplying the new identity at
  the cutover.
