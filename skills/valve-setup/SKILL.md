---
name: valve-setup
description: 'Set up valvejs for outbound API calls in Node.js or TypeScript, including shared Redis or Valkey quotas, provider feedback, waiting limits, and shutdown. Use when the user chooses valve or asks to integrate it into an application.'
license: Apache-2.0
---

# Set up valve

valve (`valvejs` on npm) queues outbound calls in each process and spends them
from one budget per `id`. The budget lives in a store: a private in-memory store
by default, or Redis/Valkey so every worker shares it. It reads provider
rate-limit headers and pauses every worker sharing the budget.

Your job is to wire it into the user's code so that the configured rules match
the provider's real quota, every caller that spends that quota goes through the
same valve, and the process shuts down cleanly. A valve that is configured with
the wrong scope (one per worker, one per request, a fresh memory store per
module) looks like it works locally and still produces 429s in production, so
most of the care below goes into getting the scope right.

Check the project's installed version and lockfile before using an API.
`npm view valvejs version` reports the registry version, not the installed one.
Consult the [docs](https://valvejs.vercel.app/docs/) and the matching package
source when versions differ; do not upgrade an existing integration implicitly.

## Workflow

### 1. Inspect the project before writing code

Look for, and note in your final summary:

- Runtime and module setup: Node.js version (valve needs 20+), ESM or CommonJS,
  TypeScript, package manager (lockfile).
- Every place that calls the provider: `fetch`, undici, axios, got, or an SDK.
  Grep for the provider's hostname and SDK imports. All of them must go through
  the valve, or the valve undercounts.
- Existing throttling to replace: `p-limit`, `p-queue`, `bottleneck`,
  `setTimeout`/sleep loops, custom 429 retry loops. See
  [references/replace-existing-limiters.md](references/replace-existing-limiters.md).
  If the project uses Bottleneck, use the `valve-migrate-from-bottleneck` skill
  if it is available.
- Deployment shape: one script or service process, or several processes
  (replicas, pods, cluster mode, queue workers, serverless instances). More than
  one process calling with the same credential means Redis is required.
- An existing Redis client (`ioredis` or `redis`/node-redis) and where it is
  created. Reuse it instead of opening a new connection, except a BullMQ
  connection created with `maxRetriesPerRequest: null`; give valve its own
  general-purpose client in that case.

### 2. Get the real quota and its scope

Rules must come from the provider's documented quota for the user's plan. Ask
the user or read the provider docs. If you cannot confirm a number, put it in a
clearly named constant with a comment saying it must be confirmed, and say so in
your summary. Never present an invented limit as the provider's.

Also find the quota's **scope**: per credential, per account, per endpoint, per
model, per recipient. The scope decides the `id`:

- One `id` per independently enforced quota, for example
  `hubspot:portal-123` or `openai:org-42:model-small`.
- Every process and call site that spends that quota uses the same `id`, store,
  and rules.
- Never put a worker id, hostname, pid, random suffix, or request id in the
  `id`. Each would get a full private budget.
- Never put a raw API key or token in the `id`; ids appear in Redis key names.
  Use a stable non-secret account or credential identifier.
- Ids are 1 to 200 characters, no `{` or `}`.

If one request must spend a shared quota **and** a per-recipient/tenant/model
quota, or each tenant has its own credential and tier, the shape is more than a
single valve. Use the `valve-quota-design` skill if available, or read
[references/recipes.md](references/recipes.md#more-than-one-budget).

### 3. Translate the quota into rules

| Provider says                              | `rate`                                                         |
| ------------------------------------------ | -------------------------------------------------------------- |
| 100 requests per second                    | `{ limit: 100, interval: '1s' }`                               |
| 100 per second, bursts up to 20            | `{ limit: 100, interval: '1s', burst: 20 }`                    |
| 1,000 per calendar minute                  | `{ limit: 1000, interval: '1m', algorithm: 'fixed-window' }`   |
| 10,000 per day, resets at UTC midnight     | `{ limit: 10000, interval: '24h', algorithm: 'fixed-window' }` |
| 10 per second and 100,000 per day          | An array with both rules; every job spends from each.          |
| Max N requests in flight                   | `concurrency: N` (per process) or the global form below.       |
| Some endpoints cost more (weights, points) | Same rules, plus `cost` per call.                              |

Defaults and constraints that matter:

- GCRA with `burst: 1` is the default and spaces starts evenly
  (`interval / limit` apart). Only raise `burst` when the provider allows
  bursts.
- Under GCRA a job's `cost` must be at most `burst`; under fixed window, at most
  `limit`. Otherwise it rejects with `COST_EXCEEDS_LIMIT`.
- Fixed windows align to the epoch on the store clock (UTC), not to process
  start or local midnight, and can admit `2 x limit` across a boundary.
- Exact rolling windows ("100 in any 24 hours") are not supported. Use GCRA to
  pace below it, or fixed-window if the provider actually resets on a boundary,
  and rely on provider feedback for the rest.
- Unnamed rules cannot share the same algorithm and interval; give them `name`s.
- Leave headroom (for example 90 to 95% of the limit) when other systems use the
  same credential without valve.
- `concurrency: 5` limits one process. `concurrency: { limit: 5, scope: 'global' }`
  limits every process sharing the id through leases (needs a shared store).

### 4. Choose the store

- **One process** (script, CLI, single service): omit `store`. Each valve then
  has its own private memory store. To share a budget between valves in the
  same process, pass one `memoryStore()` instance to all of them.
- **Several processes**: `redisStore({ client })` from `valvejs/redis` with a
  connected ioredis (`Redis` or `Cluster`) or node-redis v4/v5 client. Redis
  6.2+ or Valkey 7.2+. Create one store per process and reuse it for every
  valve. See [references/redis.md](references/redis.md) for client settings,
  prefixes, the optional pub/sub `subscriber`, and server configuration
  (`maxmemory-policy noeviction`).

valve has no dependencies and never imports, opens, or closes a Redis client.

### 5. Create the valve once per process

Put valves in one module (for example `src/rate-limits.ts`) and export them.
Create them at module scope or during startup, never inside a request handler,
job handler, or loop: a new valve per call has a new local queue and, without a
shared store, a new budget.

```ts
import { createValve } from 'valvejs';
import { redisStore } from 'valvejs/redis';
import { redis } from './redis'; // the app's existing, connected client

export const store = redisStore({ client: redis });

export const hubspot = createValve({
  id: `hubspot:portal-${process.env.HUBSPOT_PORTAL_ID}`,
  rate: { limit: 190, interval: '10s' }, // From the provider's documented quota for this plan
  maxWait: '30s',
  store,
});
```

### 6. Route every call through it

- **fetch / undici**: `const hubspotFetch = hubspot.wrapFetch()` (or
  `wrapFetch(undiciFetch)`). Same signature as fetch. It reads rate-limit
  headers on every response and retries 429 (and 503 with `Retry-After`) after
  the shared pause, for GET, HEAD, OPTIONS, PUT and DELETE, up to `retries: 2`
  extra attempts.
- **POST / PATCH**: not retried by default. Only set `retryUnsafeMethods: true`
  on a dedicated wrapper for operations whose idempotency the provider
  guarantees (for example with an idempotency key). Feedback still applies
  without it.
- **Other clients or SDKs**: `valve.run(({ signal }) => call(signal), { observe })`
  or `valve.wrap(fn)`. `observe` maps a resolved result to `{ status, headers }`.
  Clients that throw on 4xx (axios, got by default) never resolve a 429, so call
  `valve.observe(error.response)` in the catch as well. Recipes:
  [references/http-clients.md](references/http-clients.md).
- `run(fn)` calls `fn({ signal })`, not with your arguments. Write
  `run(() => getContact(id))`, never `run(getContact)`.
- Pass the job `signal` to the HTTP client so cancellation and lost global
  leases stop the request.
- Don't wrap the same request twice (for example `run` around a `wrapFetch`
  call). Each layer admits and spends separately.

### 7. Bound waiting to fit the caller

valve waits forever by default. Pick limits from what the caller can afford:

| Context                       | Suggested settings                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------- |
| HTTP request handler          | `maxWait` of 1 to 5s, `maxQueue`, higher `priority` for user traffic, abort when the client disconnects |
| Durable queue worker (BullMQ) | `maxWait` below the job timeout; let the queue retry `MAX_WAIT_EXCEEDED`                                |
| Batch script / backfill       | Often unbounded is fine; feed huge lists in chunks with `idle()`                                        |

`maxWait` bounds time in the queue only. For an end-to-end deadline, pass
`AbortSignal.timeout(ms)` as the job `signal` and forward the callback signal to
the HTTP client. Running code must honor cancellation; signals cannot forcibly
stop arbitrary functions.

### 8. Handle valve's errors

valve rejects with `ValveError` only for its own failures; your function's
errors pass through unchanged. Narrow with `isValveError(error, code)`:

- `QUEUE_FULL`, `MAX_WAIT_EXCEEDED`: shed load or return 503 with `Retry-After`.
- `ABORTED`, `CLOSED`: usually expected (client left, shutdown).
- `COST_EXCEEDS_LIMIT`, `INVALID_OPTIONS`: configuration bug, fix it.
- `LEASE_LOST`: global concurrency lease lost; outcome unknown, keep work
  idempotent.

Subscribe to `warning` and `store-error` events and log them.

### 9. Shut down in order

valve holds timers while work is queued or paused, so the process may not exit
until valves close. On SIGTERM (or at the end of a script):

1. Stop accepting new work (close the HTTP server, `worker.close()` for queues).
2. `await valve.close({ drain: true })` to finish queued work, or `close()` to
   reject it with `CLOSED`. Running jobs are always awaited.
3. `await store.close()` if you passed a `subscriber`.
4. Quit the Redis clients you created (subscriber, then command client).

With `onStoreError: 'wait'` (the default) and no `maxWait`, a drain can hang
while Redis is down. Set `maxWait`, or abort queued jobs at your deadline.

### 10. Verify

- Install with the project's package manager (`pnpm add valvejs`, `npm install valvejs`, ...).
- Typecheck and run existing tests.
- For a quick behavioral check without a provider, use a memory store and feed a
  synthetic response: `valve.observe({ status: 429, headers: { 'retry-after': '1' } })`
  should make `valve.stats().pausedUntil` non-null.
- With Redis available, start two processes with the same id and confirm they
  share the budget.

## Final summary for the user

Report: the quota and scope you assumed (and which numbers need confirming),
the ids chosen, the store, each call site you routed, waiting/shutdown
behavior, and anything you could not route through valve. Point to
<https://valvejs.vercel.app/docs/guarantees/> for what the bounds do and do not
cover (they apply at admission on the store clock, not at provider arrival).

## Reference files

- [references/api.md](references/api.md): options, methods, events, error codes.
- [references/redis.md](references/redis.md): Redis/Valkey clients, settings, key layout, shutdown.
- [references/http-clients.md](references/http-clients.md): fetch, undici, axios, got, SDK wrappers.
- [references/recipes.md](references/recipes.md): queue workers, request handlers, batch scripts, layered quotas, multiple budgets.
- [references/replace-existing-limiters.md](references/replace-existing-limiters.md): migrating from p-limit, p-queue, sleeps, and custom 429 loops.
