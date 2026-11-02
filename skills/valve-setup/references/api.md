# valve API cheat sheet

Condensed from the [API reference](https://valvejs.vercel.app/docs/reference/api/).
The package ships full TypeScript declarations; read
`node_modules/valvejs/dist/index.d.ts` when you need exact types.

## Contents

- [Entry points](#entry-points)
- [createValve options](#createvalve-options)
- [Rate rules](#rate-rules)
- [Valve methods](#valve-methods)
- [Run options](#run-options)
- [wrapFetch options](#wrapfetch-options)
- [Events and stats](#events-and-stats)
- [Error codes](#error-codes)

## Entry points

| Import            | Exports                                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------------------------- |
| `valvejs`         | `createValve`, `runSequential`, `memoryStore`, `ValveError`, `isValveError`, `defaultFeedback`, all types |
| `valvejs/redis`   | `redisStore`, `RedisEvalAdapter` and client types                                                         |
| `valvejs/headers` | `retryAfter`, `ietfRateLimit`, `xRateLimit`, `combine`, `defaultFeedback`                                 |
| `valvejs/group`   | `createValveGroup` and group types (opt-in subpath, not in `valvejs`)                                     |

ESM and CommonJS builds. Node.js 20+. Zero runtime and peer dependencies.

## createValve options

`createValve(options)` throws `ValveError` code `INVALID_OPTIONS` on bad input.
At least one of `rate` or a finite `concurrency` is required.

| Option         | Type                                     | Default                      | Notes                                                                  |
| -------------- | ---------------------------------------- | ---------------------------- | ---------------------------------------------------------------------- |
| `id`           | `string`                                 | required                     | Names the shared budget. 1 to 200 chars, no `{` `}`.                   |
| `rate`         | `RateRule \| RateRule[]`                 | none                         | One rule or a non-empty array; every job spends from every rule.       |
| `concurrency`  | `number \| { limit, scope?, leaseTtl? }` | `Infinity`                   | Number = this instance. `scope: 'global'` = all processes with the id. |
| `store`        | `Store`                                  | new private memory store     | `memoryStore()` or `redisStore(...)`.                                  |
| `maxQueue`     | `number`                                 | `Infinity`                   | Waiting jobs in this process; beyond it `QUEUE_FULL`.                  |
| `maxWait`      | `Duration`                               | no limit                     | Max time a job waits before starting; then `MAX_WAIT_EXCEEDED`.        |
| `feedback`     | `Feedback \| false`                      | `defaultFeedback`            | Header reader. `false` disables headers but keeps 429 backoff.         |
| `maxPause`     | `Duration`                               | `'15m'`                      | Cap on one feedback/backoff pause (manual `pause()` is not capped).    |
| `backoff`      | `{ base?, max? }`                        | `{ base: '1s', max: '30s' }` | Exponential pause after a 429 without a usable header.                 |
| `onStoreError` | `'wait' \| 'throw' \| 'open'`            | `'wait'`                     | `'open'` drops shared rate guarantees during outages.                  |
| `limits`       | `'immutable' \| 'managed'`               | `'immutable'`                | `'managed'` makes stored `limit`/`burst` authoritative and updatable.  |
| `batch`        | `number`                                 | `32`                         | Max jobs per store call.                                               |

`Duration`: milliseconds as a number, or a string with `ms`, `s`, `m`, `h`
(`'1.5s'`, `'10m'`, `'24h'`). No days unit: use `'24h'`.

Global concurrency: `{ limit, scope: 'global', leaseTtl: '30s' }`. Leases renew
every `leaseTtl / 3`; a crashed worker's slots free after `leaseTtl`. Rejects
`onStoreError: 'open'`. The job signal aborts if the lease is lost and the job
rejects with `LEASE_LOST`.

## Rate rules

| Field       | Default  | Notes                                                                  |
| ----------- | -------- | ---------------------------------------------------------------------- |
| `limit`     | required | Positive integer cost units per `interval`.                            |
| `interval`  | required | Duration, at least 1ms.                                                |
| `burst`     | `1`      | GCRA only. Units that may start back to back. `cost` must be <= burst. |
| `algorithm` | `'gcra'` | Or `'fixed-window'` (epoch-aligned windows on the store clock).        |
| `name`      | none     | Stable identity. Required for scoped rules and managed limits.         |
| `scope`     | none     | Per-job identity dimension (scoped rules). Needs `name`.               |

Bounds at admission: GCRA `burst: 1` admits at most `limit` per interval, spaced
evenly; with `burst`, at most `limit + burst - 1` in any interval window; fixed
window, `limit` per aligned window (up to `2 x limit` across a boundary).

## Valve methods

| Method                              | Notes                                                                                  |
| ----------------------------------- | -------------------------------------------------------------------------------------- |
| `run(fn, options?)`                 | Queues `fn({ signal })`; resolves/rejects with its result. Never throws synchronously. |
| `wrap(fn, options?)`                | Same parameters as `fn`; each call goes through `run`.                                 |
| `wrapFetch(fetchImpl?, options?)`   | fetch-compatible wrapper with feedback and 429 retries.                                |
| `observe(response)`                 | Feed `{ status, headers }` to the feedback reader; writes a pause in the background.   |
| `pause(duration)` / `resume()`      | Shared across every process with the id; resolve once stored.                          |
| `getLimits()` / `updateLimits(...)` | Managed limits only. See the runtime limits guide.                                     |
| `stats()`                           | `{ queued, running, pausedUntil, totals }` for this process.                           |
| `on(event, listener)`               | Returns an unsubscribe function.                                                       |
| `idle()`                            | Resolves when nothing is queued or running in this process.                            |
| `close({ drain? })`                 | Stop accepting work. Without drain, queued jobs reject `CLOSED`. Awaits running jobs.  |
| `[Symbol.asyncDispose]`             | `await using valve = createValve(...)` closes without draining.                        |

## Run options

| Option     | Default         | Notes                                                                                  |
| ---------- | --------------- | -------------------------------------------------------------------------------------- |
| `cost`     | `1`             | Units spent from every rule. Concurrency always counts one per job.                    |
| `priority` | `0`             | Integer, higher starts first, only within this process.                                |
| `maxWait`  | valve `maxWait` | Per-job queue deadline. `0` = first-attempt admission or rejection; see details below. |
| `signal`   | none            | Cancels while queued (`ABORTED`); passed to `fn` once running.                         |
| `observe`  | none            | `(result) => ResponseLike \| undefined` for feedback from resolved values.             |
| `scopes`   | none            | Required identities for scoped rules, `{ recipient: 'contact-42' }`.                   |

`maxWait: 0` is not a synchronous capacity probe. With an asynchronous store,
a zero-wait job can wait behind an in-flight store call until its batch is
sent; it rejects if the scheduler cannot send an attempt or higher-priority
work takes its place. See the installed `ValveOptions.maxWait` TSDoc.

## wrapFetch options

| Option               | Default         | Notes                                                                          |
| -------------------- | --------------- | ------------------------------------------------------------------------------ |
| `retries`            | `2`             | Extra attempts after 429, or 503 with valid `Retry-After`. `0` disables.       |
| `retryUnsafeMethods` | `false`         | Allow retrying POST, PATCH, other methods. Only for verified idempotent calls. |
| `cost`               | `1`             | Number or `(input, init) => number`.                                           |
| `priority`           | `0`             | Number or `(input, init) => number`.                                           |
| `maxWait`            | valve `maxWait` | Per attempt.                                                                   |
| `scopes`             | none            | Object or synchronous resolver of the fetch arguments.                         |
| `maxReplayBodySize`  | `65536`         | Bytes of an inherited `Request` body probed for replay. `0` sends once.        |

The request's own abort signal cancels queued attempts. A `ReadableStream`
`init.body` is never retried. After the last retry the final response is
returned unchanged (it does not throw on 429).

## Events and stats

| Event         | Payload                             | When                                                 |
| ------------- | ----------------------------------- | ---------------------------------------------------- |
| `pause`       | `{ durationMs, reason }`            | reason: `manual`, `feedback`, `backoff`, `store`     |
| `resume`      | `{ reason: 'manual' \| 'expired' }` | A pause ends.                                        |
| `reject`      | `{ code }`                          | valve rejected a job with a `ValveError`.            |
| `store-error` | `{ error, policy }`                 | A store call failed or timed out.                    |
| `idle`        | `{}`                                | Last queued/running job settled.                     |
| `warning`     | `{ message }`                       | A callback threw, a pause was capped, managed drift. |
| `limits`      | `LimitsSnapshot`                    | This process saw a new managed-limits version.       |

`stats().totals` has `started`, `succeeded`, `failed`, `rejected`, `retried`,
`storeErrors`. Events and stats are per process.

## Error codes

`ValveError` has `code`, `valveId`, `message`, and optional `cause`.
`isValveError(error, code?)` narrows.

| Code                 | Meaning                                                 | Usual response                               |
| -------------------- | ------------------------------------------------------- | -------------------------------------------- |
| `INVALID_OPTIONS`    | Bad option, or store-pinned config mismatch for the id  | Fix configuration                            |
| `COST_EXCEEDS_LIMIT` | `cost` above a rule's `burst` (GCRA) or `limit` (fixed) | Lower cost or raise burst                    |
| `QUEUE_FULL`         | `maxQueue` reached                                      | Shed load, 503/429 to caller                 |
| `MAX_WAIT_EXCEEDED`  | Waited longer than `maxWait`                            | Fail fast or retry later                     |
| `ABORTED`            | Signal aborted before start; `cause` is `signal.reason` | Usually nothing                              |
| `CLOSED`             | Valve closed before the job started                     | Expected during shutdown                     |
| `STORE_UNAVAILABLE`  | Store failed under `'throw'`, or a managed control call | Retry; managed update outcome may be unknown |
| `LEASE_LOST`         | Global concurrency lease expired or failed to renew     | Treat outcome as unknown; idempotent work    |
| `LIMITS_CONFLICT`    | `updateLimits` `expect` did not match                   | Re-read snapshot, reconcile, retry           |
