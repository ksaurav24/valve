# valve

[![CI](https://github.com/ksaurav24/valve/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/ksaurav24/valve/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**One rate limit for every worker that calls an API.**

valve queues outbound API calls under one budget shared by your workers,
stored in Redis or Valkey. When the provider asks you to slow down, every
worker sharing that budget pauses. A memory store supports single-process use.

## Quickstart

The package is `@ksaurav24/valve`, version 0.1.2. The source repository is
public, but the package is **not published to npm yet**. Build it locally with
`pnpm install && pnpm build`, then run a workspace example or install a packed
tarball in another project.

```ts
import { createValve } from '@ksaurav24/valve';
import { redisStore } from '@ksaurav24/valve/redis';

const api = createValve({
  id: 'partner:credential-42',
  rate: { limit: 100, interval: '1s' },
  store: redisStore({ client: redis }),
});
const limitedFetch = api.wrapFetch();
const response = await limitedFetch('https://api.example.com/contacts');
```

Pass a connected `ioredis` or `node-redis` client. valve uses its structural
interface and never owns its connection. Each worker uses the same server,
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
- Supports GCRA, fixed windows, and several rules checked together.
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
store is unavailable. Read the [full guarantees](docs/content/docs/guarantees.mdx).

## Documentation and development

```sh
pnpm install
pnpm check
pnpm docs:dev
```

The Next.js website lives in `docs/`: `/` introduces the project, `/docs` serves
the Fumadocs MDX documentation, and `/changelog` renders the package
changelog. Blog scaffolds are kept for future library and release posts. Build it with `pnpm docs:build`.
See [website maintenance](docs/README.md) for content and routing conventions.

- [Quickstart](docs/content/docs/quickstart.mdx)
- [Share a quota](docs/content/docs/guides/share-a-quota.mdx)
- [Respect Retry-After](docs/content/docs/guides/respect-retry-after.mdx)
- [Priorities and shutdown](docs/content/docs/guides/priorities-and-shutdown.mdx)
- [Migrate from Bottleneck](docs/content/docs/migration/from-bottleneck.mdx)
- [API reference](docs/content/docs/reference/api.mdx)
- [Tests and benchmarks](docs/content/docs/reference/testing.mdx)
- [Contributing](CONTRIBUTING.md)

Run `pnpm test` for unit and property tests, `pnpm test:coverage` for coverage,
and `pnpm test:types` for inference checks. With Redis running, use
`REDIS_URL=redis://127.0.0.1:6379 pnpm test:integration` for real-store tests.

Postgres, global concurrency, provider presets, and Bottleneck compatibility
are planned for later versions. Publishing remains to be configured.

## Contributing and security

Contributions are welcome through [GitHub Issues](https://github.com/ksaurav24/valve/issues) and pull requests. Read the [contributing guide](CONTRIBUTING.md) and [Code of Conduct](CODE_OF_CONDUCT.md) before contributing. Report suspected vulnerabilities privately using the [security policy](SECURITY.md), not public issues.

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
