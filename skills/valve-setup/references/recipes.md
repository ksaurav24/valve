# Recipes

Adapted from the [examples](https://valvejs.vercel.app/docs/examples/). Limits
are illustrative; use the provider's documented quota.

## Contents

- [Queue workers (BullMQ or similar)](#queue-workers-bullmq-or-similar)
- [HTTP request handlers](#http-request-handlers)
- [Batch scripts](#batch-scripts)
- [Layered quotas and weighted endpoints](#layered-quotas-and-weighted-endpoints)
- [More than one budget](#more-than-one-budget)

## Queue workers (BullMQ or similar)

The durable queue owns persistence and retries; valve owns the provider quota.
Put valve around the outbound calls inside each job, not around the job.

```ts
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { createValve, isValveError } from 'valvejs';
import { redisStore } from 'valvejs/redis';

const redis = new Redis(process.env.REDIS_URL!, { enableOfflineQueue: false }); // valve
const bullConnection = new Redis(process.env.REDIS_URL!, {
  maxRetriesPerRequest: null, // BullMQ needs its own connection
});

const hubspot = createValve({
  id: 'hubspot:portal-123',
  rate: { limit: 190, interval: '10s' },
  store: redisStore({ client: redis }),
  maxWait: '30s', // below the job timeout; the queue retries
});
const hubspotFetch = hubspot.wrapFetch();

const worker = new Worker(
  'contact-sync',
  async (job) => {
    const res = await hubspotFetch(
      `https://api.hubapi.com/crm/v3/objects/contacts/${job.data.id}`,
    );
    if (!res.ok) throw new Error(`HubSpot returned ${res.status}`);
    return res.json();
  },
  { connection: bullConnection, concurrency: 20 },
);

process.on('SIGTERM', async () => {
  await worker.close(); // stop taking jobs
  await hubspot.close();
  await redis.quit();
  await bullConnection.quit();
});
```

Prefer this over the queue's own limiter when one job makes several calls,
several queues or services share the credential, or provider headers matter.
BullMQ `concurrency` is per worker process; add valve global concurrency if the
provider caps concurrent requests.

## HTTP request handlers

A user is waiting, so fail fast instead of queueing indefinitely:

```ts
const maps = createValve({
  id: 'maps:key-3',
  rate: { limit: 50, interval: '1s' },
  store,
  maxQueue: 500,
});
const mapsFetch = maps.wrapFetch(fetch, { priority: 10, maxWait: '2s' });

app.get('/geocode', async (req, res) => {
  const controller = new AbortController();
  res.on('close', () => controller.abort());
  try {
    const upstream = await mapsFetch(url, { signal: controller.signal });
    res.status(upstream.status).json(await upstream.json());
  } catch (error) {
    if (
      isValveError(error, 'QUEUE_FULL') ||
      isValveError(error, 'MAX_WAIT_EXCEEDED')
    ) {
      res
        .set('Retry-After', '2')
        .status(503)
        .json({ error: 'Busy, retry shortly.' });
      return;
    }
    if (isValveError(error, 'ABORTED')) return; // client left
    throw error;
  }
});
```

Choose `maxWait` from what the caller can tolerate. Priority only orders jobs
inside one process; to stop a background process from taking the whole shared
budget, give it a low local `concurrency`.

## Batch scripts

One process, memory store, wait as long as needed:

```ts
const github = createValve({
  id: 'github:backfill',
  rate: { limit: 80, interval: '1m' },
  concurrency: 4,
});
const githubFetch = github.wrapFetch(fetch, { retries: 3 });

const failures: unknown[] = [];
try {
  for (let i = 0; i < ids.length; i += 1000) {
    const results = await Promise.allSettled(
      ids.slice(i, i + 1000).map(async (id) => {
        const res = await githubFetch(`https://api.github.com/repos/${id}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await save(await res.json());
      }),
    );
    for (const result of results)
      if (result.status === 'rejected') failures.push(result.reason);
  }
} finally {
  await github.close();
}
if (failures.length)
  throw new AggregateError(failures, 'Backfill items failed');
```

Await the full chunk, including response parsing and saving. `valve.idle()`
only waits for admitted callbacks, not work chained after their promises.

GitHub-style `x-ratelimit-remaining: 0` pauses until the reset even if the rule
is looser than the real limit. On Ctrl-C, `close()` rejects queued jobs with
`CLOSED`; filter them with `isValveError(error, 'CLOSED')`.

## Layered quotas and weighted endpoints

```ts
const search = createValve({
  id: 'search-api:key-5',
  rate: [
    { limit: 20, interval: '1s', burst: 10 },
    { limit: 50_000, interval: '24h', algorithm: 'fixed-window' },
  ],
  store,
});
export const lookup = (id: string) =>
  search.run(() => api.lookup(id), { cost: 1 });
export const fullText = (q: string) =>
  search.run(() => api.search(q), { cost: 5 }); // needs burst >= 5
```

Monthly quotas: intervals are fixed durations; approximate with a daily rule
(monthly / 31) or track usage elsewhere.

## More than one budget

| Situation                                                              | Shape                                                               |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Independent quotas per endpoint or model                               | Separate valves with separate ids, same store                       |
| One request spends a shared quota and a per-recipient/tenant quota     | One valve, named rules with `scope`, `run(fn, { scopes: { ... } })` |
| Each tenant/credential has its own quota or tier                       | `createValveGroup` from `valvejs/group`                             |
| Two separate valves must both admit, and the first charge should stand | `runSequential` (not atomic)                                        |

Scoped rules example:

```ts
const messages = createValve({
  id: 'messaging:business-123',
  rate: [
    { name: 'throughput', limit: 80, interval: '1s', burst: 8 },
    { name: 'spacing', scope: 'recipient', limit: 1, interval: '6s' },
  ],
  store,
});
await messages.run(() => send(msg), { scopes: { recipient: contactId } });
```

Use opaque ids for identities, never phone numbers or tokens. For the full
decision guide use the `valve-quota-design` skill or
<https://valvejs.vercel.app/docs/guides/compose-valves/>.
