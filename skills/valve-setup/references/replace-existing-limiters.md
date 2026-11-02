# Replacing existing throttling

Replace throttling that spends the same provider quota when valve takes over.
Preserve limits serving a different purpose, such as bounding memory, database
connections, or job fan-out. Two scheduling layers can add unnecessary waiting,
but their effect depends on the workload.

## p-limit / p-queue concurrency only

`pLimit(4)` limits running promises in one process. If the provider limit is a
rate, the concurrency cap was a proxy for it: replace it with the real rate
rule, and keep `concurrency` only if the provider also caps in-flight requests
or the caller needs to protect itself.

```ts
// Before
const limit = pLimit(4);
await Promise.all(ids.map((id) => limit(() => getUser(id))));

// After
const api = createValve({
  id: 'users-api:key-1',
  rate: { limit: 10, interval: '1s' },
  concurrency: 4,
});
await Promise.all(ids.map((id) => api.run(() => getUser(id))));
```

If there is no provider quota at all and only one process, p-limit is the
simpler tool; say so instead of forcing valve in.

## p-queue with interval / intervalCap

`new PQueue({ intervalCap: 10, interval: 1000, concurrency: 2 })` maps to
`rate: { limit: 10, interval: '1s', algorithm: 'fixed-window' }` for a windowed
quota, or a GCRA rule `{ limit: 10, interval: '1s' }` to spread
starts evenly (usually kinder to providers). p-queue `priority` is also
higher-first, so values carry over. `queue.onIdle()` maps to `valve.idle()`.
This is not exact equivalence: valve windows align to the store epoch, while
p-queue interval timing and carry-over options depend on its configuration.

## Sleep loops

```ts
// Before
for (const id of ids) {
  await call(id);
  await sleep(250);
}
```

`sleep(250)` after each call is roughly `{ limit: 4, interval: '1s' }`, except
that the old loop also waited for each call to finish. With valve, calls can
overlap; add `concurrency: 1` to keep strictly serial behavior, or allow overlap
if the provider permits it.

## Hand-written 429 retry loops

Replace retry-on-429 loops around fetch with `wrapFetch` (`retries` defaults to
2, for GET, HEAD, OPTIONS, PUT, DELETE). The shared pause means other workers
also back off, which a local loop could not do. Keep retry logic for non-429
failures (network errors, 5xx) in the existing retry library or job queue;
valve retries 503 only when a valid `Retry-After` is present.

If the old loop retried POSTs, only keep that behavior with
`retryUnsafeMethods: true` on a dedicated wrapper after confirming the
provider's idempotency contract, and tell the user you did.

## In-memory token buckets and counters

Custom per-process counters do not coordinate across workers. Replace them with
a valve on a shared store, and delete the old state.
