# Redis and Valkey store

Source: [Redis store reference](https://valvejs.vercel.app/docs/reference/redis-store/)
and [Share a quota](https://valvejs.vercel.app/docs/guides/share-a-quota/).

## Requirements

- Redis 6.2+ or Valkey 7.2+, reachable from every worker.
- ioredis 5 (`Redis` or `Cluster`) or node-redis v4/v5 (call `connect()` first).
  Any other client works through a `RedisEvalAdapter` with `eval` and `evalsha`.
- Every worker sharing a budget uses the same server, database, `prefix`, and
  `id`. Immutable rules must be identical on every worker.

## Create the store

```ts
// ioredis
import { Redis } from 'ioredis';
import { redisStore } from 'valvejs/redis';

const redis = new Redis(process.env.REDIS_URL!, { enableOfflineQueue: false });
export const store = redisStore({ client: redis });
```

```ts
// node-redis v4/v5
import { createClient } from 'redis';
import { redisStore } from 'valvejs/redis';

const redis = await createClient({
  url: process.env.REDIS_URL,
  disableOfflineQueue: true,
}).connect();
export const store = redisStore({ client: redis });
```

One store per process, reused by every valve. Options:

| Option       | Default   | Notes                                                                 |
| ------------ | --------- | --------------------------------------------------------------------- |
| `client`     | none      | Connected client. Exactly one of `client` or `adapter`.               |
| `adapter`    | none      | `{ eval, evalsha }` for other clients; rethrow `NOSCRIPT` unchanged.  |
| `prefix`     | `'valve'` | Key prefix, no braces. Use it to separate environments on one server. |
| `timeout`    | `'2s'`    | Per store call; a timeout counts as a store error (outcome unknown).  |
| `subscriber` | none      | A **separate** connected client for pub/sub wakeups.                  |

## Recommended client settings for a dedicated valve client

Timeouts do not cancel commands already sent, and offline queues can replay
commands later. When valve has its own client, disable offline queuing:

```ts
const redis = new Redis(process.env.REDIS_URL!, {
  enableOfflineQueue: false,
  autoResendUnfulfilledCommands: false,
  maxRetriesPerRequest: 1,
});
```

node-redis: `createClient({ url, disableOfflineQueue: true })`.

valve never changes client settings. If you reuse the app's shared client, do
not change its settings out from under other code; mention the trade-off to the
user instead. Never reuse a BullMQ connection (`maxRetriesPerRequest: null`).

## Subscriber (optional)

Without a subscriber, a process notices another process's `resume()` or a freed
global slot on its next store call (global-slot waiters poll about every 50ms).
With one, wakeups are immediate. Recommended with global concurrency or managed
limits.

```ts
const subscriber = redis.duplicate(); // ioredis
// node-redis: const subscriber = await redis.duplicate().connect();
const store = redisStore({ client: redis, subscriber });
```

## Server configuration

- `maxmemory-policy noeviction` on the instance holding valve keys. Eviction
  can silently reset spent budgets and the pinned configuration key. Required
  for managed limits.
- Persistence (AOF) reduces loss on restart. Rate history lost to a flush,
  restart, eviction, or failover gives a fresh budget with no error; the
  provider's own limit is the final backstop.

## Key layout and configuration pinning

Keys look like `PREFIX:{ID}:...`; the `{ID}` hash tag keeps one valve in one
Cluster slot. The first admission pins a fingerprint of the rules and global
concurrency at `PREFIX:{ID}:config` (no TTL). A worker with different immutable
rules for the same id gets `INVALID_OPTIONS` on its jobs. Changing rules
therefore needs a coordinated migration (drain, wait for recovery, delete only
the config key). Never delete keys or switch ids while workers are running to
"reset" a budget. Use `limits: 'managed'` if numeric limits need to change at
runtime.

## Shutdown order

```ts
process.on('SIGTERM', async () => {
  await api.close({ drain: true }); // 1. every valve (and group)
  await store.close(); // 2. removes subscriptions, never closes clients
  await subscriber.quit(); // 3. your clients
  await redis.quit();
});
```
