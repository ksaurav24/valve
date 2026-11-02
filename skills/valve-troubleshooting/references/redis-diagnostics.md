# Redis and Valkey diagnostics

Source: [Redis store reference](https://valvejs.vercel.app/docs/reference/redis-store/).

Use read-only commands against production. Never `FLUSHDB`, `FLUSHALL`, or
delete valve keys while workers run.

## Key layout

| Key                                     | Holds                              |
| --------------------------------------- | ---------------------------------- |
| `PREFIX:{ID}:config`                    | Pinned policy fingerprint (no TTL) |
| `PREFIX:{ID}:r:<rule-key>`              | Unscoped rule state                |
| `PREFIX:{ID}:s:named:<NAME>:<identity>` | Scoped rule state                  |
| `PREFIX:{ID}:leases`                    | Global concurrency leases          |

Default prefix is `valve`. `{ID}` is a Cluster hash tag, so one valve is on one
slot.

```sh
redis-cli -u "$REDIS_URL" --scan --pattern 'valve:{hubspot:portal-123}:*'
redis-cli -u "$REDIS_URL" TTL 'valve:{hubspot:portal-123}:r:gcra:10000'
redis-cli -u "$REDIS_URL" INFO stats | grep -E 'evicted_keys|expired_keys'
redis-cli -u "$REDIS_URL" CONFIG GET maxmemory-policy
```

## Timeouts (`store-error`, `STORE_UNAVAILABLE`)

- `redisStore({ timeout })` defaults to `'2s'`. A timeout has an unknown
  outcome: Redis may have executed the script, or the client may send it later.
- Client offline queues can replay commands after reconnect (late pauses,
  resumes, abandoned leases). For a dedicated valve client use
  `enableOfflineQueue: false`, `autoResendUnfulfilledCommands: false`,
  `maxRetriesPerRequest: 1` (ioredis) or `disableOfflineQueue: true`
  (node-redis).
- A BullMQ connection (`maxRetriesPerRequest: null`) must not be shared with
  valve.
- With `onStoreError: 'wait'`, set `maxWait` so outages do not queue forever.

## Silent budget resets

Symptoms: bursts of provider 429s after a Redis restart, failover, or memory
pressure, with no valve errors. Causes: `FLUSHDB`, restart without persistence,
eviction (`volatile-*` evicts TTL'd rate/lease keys; `allkeys-*` also the config
key), or failover to a lagging replica. Use `maxmemory-policy noeviction`,
AOF persistence, memory headroom, and alerts on `evicted_keys`. Managed valves
emit a `warning` on a new registration epoch or a backwards version.

## OOM

With `noeviction`, a full instance rejects writes with `OOM`; valve treats it as
a store error handled by `onStoreError`. Free memory or scale; don't switch to
an evicting policy to make it go away.

## Subscriber problems

- `INVALID_OPTIONS` at `redisStore`: the subscriber is the same object as the
  client. Use `redis.duplicate()`.
- node-redis: the duplicated subscriber must be `connect()`ed before use.
- Without a subscriber, cross-process resume and slot release are noticed on
  the next store call (global-slot waiters poll about every 50ms). With one,
  waiters still recheck at least once a second, so a missed message costs at
  most about a second.

## Cluster

ioredis `Cluster` and node-redis cluster clients work as `client` with no extra
settings. Ids and prefixes must not contain braces. A hot valve is a hot slot;
it cannot be spread across shards.

## NOSCRIPT

After a server restart, valve falls back from `EVALSHA` to `EVAL`
automatically. A custom `RedisEvalAdapter` must rethrow `NOSCRIPT` errors
unchanged, or this recovery breaks.
