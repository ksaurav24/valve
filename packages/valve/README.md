# valvejs

[![npm version](https://img.shields.io/npm/v/valvejs.svg)](https://www.npmjs.com/package/valvejs)
[![npm downloads per month](https://img.shields.io/npm/dm/valvejs.svg)](https://www.npmjs.com/package/valvejs)

**One rate limit for every worker that calls an API.**

valve queues outbound API calls under one budget shared by your workers,
stored in Redis or Valkey. When the provider asks you to slow down, every
worker sharing that budget pauses. A memory store supports single-process use.

[Documentation](https://valvejs.vercel.app/docs/) · [npm package](https://www.npmjs.com/package/valvejs) · [Releases](https://valvejs.vercel.app/releases/)

## Quickstart

**Beta until 1.0.** APIs may change between releases. Published versions use
plain version numbers and install through npm’s default channel.

```sh
npm install valvejs
```

The npm badge above follows the current release automatically. See the
[release history](https://valvejs.vercel.app/releases/) for published versions
and release notes.

```ts
import { createValve } from 'valvejs';
import { redisStore } from 'valvejs/redis';

const api = createValve({
  id: 'partner:credential-42',
  rate: { limit: 100, interval: '1s' },
  store: redisStore({ client: redis }),
});
const limitedFetch = api.wrapFetch();
const response = await limitedFetch('https://api.example.com/contacts');
```

Pass a connected `ioredis` or `node-redis` client. valve uses its structural
interface and never owns its connection. Disable command-client offline queues
(`enableOfflineQueue: false` for ioredis, `disableOfflineQueue: true` for
node-redis) to reject commands issued while disconnected. Store timeouts do not
cancel commands already sent; see [timeouts and reconnection](https://valvejs.vercel.app/docs/reference/redis-store/#timeouts-and-reconnection).
Each worker uses the same server,
prefix, id, and rules. The library has zero runtime and peer dependencies.

`wrapFetch` retries rate limit responses for GET, HEAD, OPTIONS, PUT and
DELETE by default. POST and PATCH require `retryUnsafeMethods: true` after
verifying the provider's idempotency contract. Every response still updates
shared cooldowns; `retries: 0` disables automatic retries.

## What it does

- Shares a rate budget across processes with atomic Redis/Valkey scripts.
- Queues work with cost, priority, local concurrency, queue bounds, deadlines,
  and abort signals.
- Reads `Retry-After`, IETF `RateLimit`, and common `x-ratelimit-*` headers.
- Retries fetch rate limit responses after a shared pause.
- Supports GCRA pacing, explicit fixed windows, and several rules checked together.
- Spends shared and per-recipient or per-tenant budgets atomically; eligible
  identities proceed while others wait.
- Provides ESM and CommonJS entry points with TypeScript declarations.

## Choose the right tool

| Need                                                | Tool                                                  |
| --------------------------------------------------- | ----------------------------------------------------- |
| Shared outbound budget, queueing, provider feedback | valve                                                 |
| Limit parallel work inside one process              | p-limit or p-queue                                    |
| Accept or reject inbound requests                   | An inbound rate limiter                               |
| Persist jobs across process restarts                | A durable job queue, with valve around outbound calls |
| General retries or circuit breaking                 | Your HTTP client or a retry library                   |

## Guarantees

The default GCRA rule uses `burst: 1`: at most `limit` cost units start in any
half-open interval of the configured length, with one unit every
`interval / limit` milliseconds. With a larger burst, the bound becomes
`limit + burst - 1`.

Fixed windows admit at most `limit` units per aligned window. Adjacent windows
can admit `2 * limit` units near a boundary. Several rules each hold separately.
All rate calculations use the store clock.

Concurrency and queue order are local to a valve instance. A pause blocks
subsequent grants; already-issued grants can still start. A cancelled job or
timed-out store call can waste its grant. Queued work does not survive process
failure, and `onStoreError: 'open'` gives up shared rate guarantees while the
store is unavailable. Rate bounds do not survive
[loss of Redis state](https://valvejs.vercel.app/docs/guarantees/#store-state-loss) from a flush, eviction, or
failover. Read the [full guarantees](https://valvejs.vercel.app/docs/guarantees/).

## Scoped budgets

A job can spend shared and per-recipient budgets atomically:

```ts
const messages = createValve({
  id: 'business-42',
  rate: [
    { name: 'shared', limit: 80, interval: '1s', burst: 8 },
    { name: 'spacing', scope: 'recipient', limit: 1, interval: '6s' },
  ],
});
await messages.run(() => sendMessage(), {
  scopes: { recipient: 'contact-42' },
});
await messages.close();
```

Blocked recipients let other eligible jobs proceed. Supply opaque application
IDs, not phone numbers or secrets. Feedback and pauses remain Valve-wide.
See [Scoped rate limits](https://valvejs.vercel.app/docs/guides/scoped-rate-limits/)
for wrappers, store requirements, deployment safety, and limits.

## Documentation and development

```sh
pnpm install
pnpm check
pnpm docs:dev
```

The Next.js and Fumadocs MDX documentation site lives in `apps/web/`. Build it with `pnpm docs:build`.

- [Quickstart](https://valvejs.vercel.app/docs/quickstart/)
- [Share a quota](https://valvejs.vercel.app/docs/guides/share-a-quota/)
- [Choose provider quota scopes](https://valvejs.vercel.app/docs/guides/provider-quota-scopes/)
- [Respect Retry-After](https://valvejs.vercel.app/docs/guides/respect-retry-after/)
- [Priorities and shutdown](https://valvejs.vercel.app/docs/guides/priorities-and-shutdown/)
- [Migrate from Bottleneck](https://valvejs.vercel.app/docs/migration/from-bottleneck/)
- [API reference](https://valvejs.vercel.app/docs/reference/api/)
- [Tests and benchmarks](https://valvejs.vercel.app/docs/reference/testing/)
- [Contributing](https://github.com/ksaurav24/valve/blob/master/CONTRIBUTING.md)

Run `pnpm test` for unit and property tests, `pnpm test:coverage` for coverage,
and `pnpm test:types` for inference checks. With Redis running, use
`REDIS_URL=redis://127.0.0.1:6379 pnpm test:integration` for real-store tests.

Postgres stores, provider presets, and Bottleneck compatibility are planned for
later versions. Shared global concurrency is supported by Redis and Valkey.

## License

[Apache License 2.0](LICENSE). Copyright 2026 Saurav K.

Rate bounds are measured at atomic store admission. A delayed callback or network
write can occur later, so actual HTTP arrival times may bunch together.

## Shared concurrency and immediate resume

```ts
const subscriber = redis.duplicate(); // Separate ioredis subscription connection
const store = redisStore({ client: redis, subscriber });
const api = createValve({
  id: 'partner:credential-42',
  concurrency: { limit: 5, scope: 'global', leaseTtl: '30s' },
  store,
});
await api.run(({ signal }) => fetch(url, { signal }));
```

The store renews active leases and recovers slots after a worker crashes. Jobs
must honor the signal when ownership is lost. A process stalled past its TTL
can outlive its lease; external fencing is needed for strict partition safety.
Close the valves, then `store.close()`, then your own subscriber and command
clients. For node-redis, connect the duplicated subscriber before use.

Run `pnpm bench:compare` for repeated comparisons. Add `REDIS_URL` and
`VALKEY_URL` to include distributed workloads. Raw samples and methodology
are recorded in `packages/valve/bench/COMPARISON.md`.
