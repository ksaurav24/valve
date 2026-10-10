# @ksaurav24/valve

## 0.1.3

### Patch Changes

- 1cf1eea: Redis and Valkey stores now expire GCRA state and global lease sets at absolute times from the same `TIME` reading as admission. Relative TTLs counted from the server's millisecond snapshot could expire a key up to 1ms before its stored time, so a contending process could start slightly before the configured spacing. Requires no configuration change; Redis 6.2 and Valkey 7.2 remain the minimum versions.
- c33f23f: Automatic `wrapFetch()` retries now default to GET, HEAD, OPTIONS, PUT and DELETE.
  POST, PATCH and other methods return the first response unless the caller opts
  in with `retryUnsafeMethods: true` on a dedicated wrapper after verifying the
  provider's idempotency contract. An idempotency key alone does not enable retries.
  This changes the previous default that retried every method; setting `retries`
  alone no longer enables POST or PATCH replay. Every response still updates shared
  cooldowns. `retries: 0` and streamed `init.body` requests continue to disable retries.
- 545eff9: Validate Retry-After before retrying a 503 response. Malformed or empty values now return the response without retrying or consuming its body. Valid delays, shared pauses, pause caps, and 429 fallback backoff are preserved.

## 0.1.2

### Patch Changes

- 211ebb0: Minify embedded Redis Lua at build time and allow unused default feedback readers to be tree-shaken. Paired Node 24 measurements reduce the published Redis ESM bundle from 3,521 to 3,151 gzip bytes (10.5%) and a `retryAfter()` consumer from 1,089 to 445 bytes (59.1%).

  Public exports, types, store behavior, and zero runtime/peer dependencies are preserved. Core size is unchanged; no general startup, throughput, or latency improvement is claimed. The benchmark recommendation and footprint report document the regression controls, remaining size targets, and build-time trade-offs.

## 0.1.1

### Patch Changes

- a916f7e: Account for elapsed asynchronous acquisition time when scheduling rate checks
  with local concurrency. Use monotonic elapsed time so local wall-clock changes
  do not distort that adjustment. Every check still requires atomic store admission;
  global concurrency polling, shared pauses, and outage backoff retain their behavior.
- 3606210: Remove positive jitter from rate eligibility waits when concurrency is local.
  Every wakeup still checks atomic store admission. Retain jitter for global
  concurrency polling and store failure backoff.

## 0.1.0

Initial implementation: shared rate rules, memory and Redis/Valkey stores, local concurrency, queue controls, provider feedback, fetch retries, and typed ESM/CommonJS entry points. This version is not published.
