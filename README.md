# ValveJS

[![CI](https://github.com/ksaurav24/valve/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/ksaurav24/valve/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/ksaurav24/valve)](https://github.com/ksaurav24/valve/stargazers)
[![GitHub issues](https://img.shields.io/github/issues/ksaurav24/valve)](https://github.com/ksaurav24/valve/issues)

**One rate limit for every worker that calls an API.**

> **Experimental / pre-1.0:** ValveJS is under active development. APIs and behavior may change before 1.0.0. Evaluate failure modes and test against your workload before production use.

valve queues outbound API calls under one budget shared by your workers,
stored in Redis or Valkey. When the provider asks you to slow down, every
worker sharing that budget pauses. A memory store supports single-process use.

## Beta release

A public npm beta release is being prepared. **No npm publication is confirmed yet.** The intended first beta is `0.3.0-beta.1`, published with the `beta` dist-tag so it does not become the default `latest` release. After publication, verify the package name and install command against the npm registry before using them. The proposed unscoped name `valvejs` has not yet been confirmed available; the existing package remains `@ksaurav24/valve` until the naming decision is verified.

## Quickstart

The package is `@ksaurav24/valve`. The source repository is
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
interface and never owns its connection. Disable command-client offline queues
(`enableOfflineQueue: false` for ioredis, `disableOfflineQueue: true` for
node-redis) to reject commands issued while disconnected. Store timeouts do not
cancel commands already sent; see [timeouts and reconnection](apps/web/content/docs/reference/redis-store.mdx#timeouts-and-reconnection).
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
store is unavailable. Read the [full guarantees](apps/web/content/docs/guarantees.mdx).

## Documentation and development

```sh
pnpm install
pnpm check
pnpm docs:dev
```

The Next.js website lives in `apps/web/`: `/` introduces the project, `/docs` serves
the Fumadocs MDX documentation, and `/changelog` renders the package
changelog. Blog scaffolds are kept for future library and release posts. Build it with `pnpm docs:build`.
See [website maintenance](apps/web/README.md) for content and routing conventions.

- [Quickstart](apps/web/content/docs/quickstart.mdx)
- [Share a quota](apps/web/content/docs/guides/share-a-quota.mdx)
- [Choose provider quota scopes](apps/web/content/docs/guides/provider-quota-scopes.mdx)
- [Respect Retry-After](apps/web/content/docs/guides/respect-retry-after.mdx)
- [Priorities and shutdown](apps/web/content/docs/guides/priorities-and-shutdown.mdx)
- [Migrate from Bottleneck](apps/web/content/docs/migration/from-bottleneck.mdx)
- [API reference](apps/web/content/docs/reference/api.mdx)
- [Tests and benchmarks](apps/web/content/docs/reference/testing.mdx)
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
