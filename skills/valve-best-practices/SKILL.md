---
name: valve-best-practices
description: 'Review existing valvejs usage for quota scope, shared stores, admission, retries, backpressure, and lifecycle errors. Use when reviewing or hardening a valve integration or checking whether it is ready for multiple workers.'
license: Apache-2.0
---

# valve best practices and review

Use this to review existing valve code or to check your own changes before
handing them back. Most valve bugs are silent: the code runs, tests pass with a
memory store, and production still gets 429s or overshoots the provider quota.
So review for **scope and sharing** first, then call-site correctness, then
operations.

## How to review

1. Find every valve: search for `createValve`, `createValveGroup`, `redisStore`,
   `memoryStore`, `runSequential`, `wrapFetch`, `.run(`, `.wrap(`.
2. Find every call to the provider (hostnames, SDK imports) and check whether
   it goes through a valve.
3. Work through the checklist below. For each finding record: file and line,
   what goes wrong in production (a concrete failure, not a style opinion), and
   the fix as code.
4. Order findings by impact: quota overshoot or 429 storms first, then hangs and
   lost work, then observability and style. Say explicitly when something is
   fine; don't invent findings to fill a list.
5. If you are asked to fix, make the minimal change for each finding and keep
   behavior the user relies on.

Use the user's requested review format. Include severity, file and line,
production impact, a concrete fix, and the parts that are already sound.

## Checklist

### A. Budget scope (highest impact)

- **One budget per provider quota.** The `id` must identify the quota the
  provider enforces (credential, account, endpoint, model), and must be the same
  on every process and call site that spends it. Red flags: `process.pid`,
  `os.hostname()`, `randomUUID()`, worker index, request id, or timestamps in an
  id; two call sites for the same credential using different ids.
- **Shared store across processes.** Several processes (replicas, pods,
  cluster workers, queue consumers, serverless instances) with the same id and
  no `store` each get a private memory budget. Multiple processes need
  `redisStore` on the same server, database, and `prefix`.
- **Created once.** `createValve` inside a request handler, job handler,
  function body, or loop creates a fresh queue (and, without a shared store, a
  fresh budget) per call. Valves belong at module scope or startup. The same
  goes for `redisStore` and `createValveGroup`.
- **Same memory store when sharing in-process.** Two valves with the same id
  and no `store` share nothing. Pass one `memoryStore()` instance.
- **Identical rules.** Under the default immutable mode, every worker for an id
  must use identical rules and global concurrency, or Redis rejects jobs with
  `INVALID_OPTIONS`. Rules computed from per-process env vars or config that can
  differ between deployments are a risk.
- **Independent quotas not merged.** Unrelated endpoints, models, or
  credentials under one id share a budget and a cooldown; one 429 pauses
  everything. Separate ids (or a group) when the provider enforces them
  separately.
- **Secrets not in ids, scopes, or group keys.** These appear in Redis key
  names. Use opaque non-secret identifiers or a keyed hash.

### B. Rules match the provider

- Numbers trace to the provider's documented quota (comment or constant), with
  headroom if other systems share the credential.
- GCRA (default) for pacing; `algorithm: 'fixed-window'` only when the provider
  resets on calendar boundaries. Rolling windows are not supported exactly.
- `burst` only where the provider tolerates bursts. Every `cost` used must be
  <= the GCRA `burst` (default 1) and <= fixed-window `limit`, or the job
  rejects with `COST_EXCEEDS_LIMIT`.
- Unnamed rules with the same algorithm and interval are invalid; scoped and
  managed rules need `name`.
- A concurrency-only valve does not space requests. If the provider has a rate
  limit, there must be a rate rule.

### C. Call sites

- **`run(fn)` with a function that takes arguments.** `run` calls
  `fn({ signal })`. `valve.run(getContact)` passes the context object as the
  first argument. Use `run(() => getContact(id))` or `wrap(getContact)`.
- **Feedback reaches the valve.** `wrapFetch` observes automatically. With
  `run` and another client, use the `observe` option, and for clients that
  throw on 4xx, also observe a mapped error response in the catch. Axios uses
  `response.status`; got uses `response.statusCode`. Pass `{ status, headers }`
  to `valve.observe`, rather than assuming every client's response fits.
- **Client retries.** Disable automatic client or SDK retries that issue
  several requests inside one `run`; each attempt must be admitted separately.
- **Retries of side-effecting requests.** `retryUnsafeMethods: true` replays
  POST/PATCH. Accept it only on a dedicated wrapper for operations with a
  verified idempotency contract (for example an idempotency key the provider
  honors). An idempotency header alone does not make retries safe.
- **Double admission.** `valve.run(() => valveFetch(url))` with the same valve,
  or wrapping a request in both `group.run` and a member's `wrapFetch`, spends
  twice. Same for calling a stage valve's `wrapFetch` inside `runSequential`.
- **Signals.** Pass the job `signal` into the HTTP client. Under global
  concurrency this is how lost leases stop work.
- **Final 429 handling.** After retries, `wrapFetch` returns the final 429
  response; code must check `res.ok` / `res.status`, not assume success.
- **Bypasses.** Any provider call that skips the valve makes its accounting
  wrong.

### D. Waiting, load, and errors

- **Bounded waits where someone is waiting.** Request handlers need a short
  `maxWait` and a `maxQueue`; queue workers need `maxWait` below the job
  timeout. Unbounded is fine for batch scripts.
- **`maxWait` is not a run timeout.** Long-running calls need their own timeout
  (`AbortSignal.timeout`).
- **Error mapping.** `isValveError(error, 'QUEUE_FULL' | 'MAX_WAIT_EXCEEDED')`
  should become backpressure (503, job retry), not a 500. `ABORTED` and
  `CLOSED` are usually expected. Non-valve errors must be rethrown unchanged.
- **Huge fan-out.** Submitting millions of jobs at once keeps every closure in
  memory; feed in chunks and `await valve.idle()`.
- **Priority expectations.** Priority orders only one process's queue; it does
  not reserve shared budget against other processes.

### E. Store and Redis operations

- **`onStoreError: 'open'`** gives up shared rate limits during outages. Accept
  only if exceeding the quota is better than not calling; it is rejected with
  global concurrency anyway.
- **Redis settings.** A dedicated valve client should disable offline queues
  (`enableOfflineQueue: false` for ioredis, `disableOfflineQueue: true` for
  node-redis) so commands are not replayed after reconnect. Never reuse a BullMQ
  connection (`maxRetriesPerRequest: null`).
- **Eviction.** The Redis instance should use `maxmemory-policy noeviction`;
  `allkeys-*` can evict the pinned config key and budgets. Required for managed
  limits.
- **Subscriber.** A `subscriber` must be a separate connection (node-redis:
  connected `duplicate()`); it speeds up cross-process resume and slot release.
- **Key hygiene.** No code that deletes valve keys, flushes the database, or
  changes `prefix`/`id` to reset a spent budget.

### F. Global concurrency

- `concurrency: N` is per process. If the provider caps concurrent requests
  across the fleet, use `{ limit: N, scope: 'global' }` with a shared store.
- Jobs must honor the abort signal; `LEASE_LOST` means the outcome is unknown,
  so the work should be idempotent. Leases bound ownership, not side effects.

### G. Lifecycle

- `close()` on every valve and group before closing the store, then
  `store.close()` (if it has a subscriber), then the Redis clients. valve never
  closes clients it was given.
- Shutdown handler stops intake first (server, queue worker), then drains.
- `close({ drain: true })` with the default `onStoreError: 'wait'` and no
  `maxWait` can hang during a Redis outage; give shutdown a bound.
- Scripts that never call `close()` can keep the process alive while jobs are
  queued or paused.

### H. Observability

- Listeners for `warning` and `store-error` (both otherwise easy to miss).
- `pause` events with reason `feedback` or `backoff` happening often means the
  rule is looser than the real limit or someone else shares the credential.
- `stats()` exported per process if queue depth matters; remember it is not a
  fleet total.

### I. Advanced features (when present)

- **Scoped rules**: every job supplies exactly the configured scope dimensions;
  identities are stable opaque ids; feedback still pauses the whole id.
- **Groups** (`valvejs/group`): `resolve` is synchronous and returns no `id` or
  `store`; does not call back into the group; `maxSize` sized for the active key
  count; `QUEUE_FULL` from capacity handled as backpressure; group closed
  before its supplied store. A group is not a shared parent quota.
- **`runSequential`**: the code accepts that earlier admissions stay spent when
  a later stage denies; stages nest in the same order everywhere; no stage valve
  is re-entered inside `fn`.
- **Managed limits**: rules are named; updates go through `updateLimits` (with
  `expect` where concurrent writers exist), never by editing Redis; immutable
  workers drained before the first update.

For details behind any item, read
[references/guarantees.md](references/guarantees.md), or the docs at
<https://valvejs.vercel.app/docs/>.
