# valvejs

## 0.5.0

### Minor Changes

- 731813a: `memoryStore()` now rejects valves that share an id with different rate rules, global concurrency limit, or lease TTL with `INVALID_OPTIONS`, as the Redis store does. Mismatched configurations that previously ran with mixed limits now fail. The memory store also forgets an id's static policy once its rate, lease, and pause state expire, so short-lived ids no longer grow memory without bound.

  `ScopedAcquireResult` gains an optional `pausedMs` field. Scoped valves now update `stats().pausedUntil` and emit `pause` when the store reports a shared pause, including Redis stores without a subscriber.

  A direct `acquire` that asks for more jobs than free lease slots on an empty slot set now returns the lease TTL as its retry hint. The Redis script previously failed with a Lua error, and the memory store returned `Infinity`.

- 1dd29f3: Waiting global valves call the store far less often. `AcquireResult` and scoped `blocked` entries gain an optional `leaseBlocked` field, which the memory and Redis stores set on lease requests, so a valve waits out rate denials for the full retry hint instead of polling every 50ms. Lease waits poll every 50ms only without a subscriber, and at least once a second with one. Release notices are coalesced and answered after a short random delay that widens for valves that keep losing slots, so one release no longer sends every waiting valve to the store at once. A valve no longer polls right after its own job settles, before its lease is released. Aborts and `maxWait` expiries no longer cut short the store outage backoff under `onStoreError: 'wait'`.

### Patch Changes

- 5fb6766: `ietfRateLimit()` and `defaultFeedback` now split `RateLimit` fields in linear time and ignore fields longer than 8192 characters, so a malformed header can no longer stall the event loop. Quoted strings may contain escaped quotes and commas. Valves also register their disposer under `Symbol.for('nodejs.asyncDispose')` on Node 20 releases that lack `Symbol.asyncDispose`, so `await using` works across the supported Node 20 range.
- 2a83fc8: `maxWait: 0` now runs a job when its first admission attempt is granted and rejects it with `MAX_WAIT_EXCEEDED` otherwise. Previously every such job was rejected, even with free capacity. `redisStore` now rejects a `timeout` below 1ms with `INVALID_OPTIONS`, since a zero timeout failed every store call.

## 0.4.1

### Patch Changes

- e68dc0f: With global concurrency, `close()` now waits up to `leaseTtl` for an in-flight store admission and releases any leases it grants, so a shutdown no longer strands slots until their TTL. `close({ drain: true })` lets accepted `wrapFetch` requests finish their retries. When a retry cannot be queued, because the valve closed without draining or `maxQueue` is full, `wrapFetch` returns the rate limit response unread instead of rejecting. Errors from `wrapFetch` `cost`, `priority`, and `scopes` resolvers now count as rejections and emit `reject`.
- 2e72fcc: Keep equal-priority jobs in call order when the store denies part of a batch, and keep `wrapFetch` retries at their original queue position. Denied jobs and retries were previously appended behind later submissions.

## 0.4.0

### Minor Changes

- 12e27e0: Introduce atomic scoped rate limits, the headline feature of the 0.4 series. Requests spend shared and per-identity budgets together. Named rules select recipient, tenant, or resource counters through per-job `scopes`; memory and Redis/Valkey stores spend every applicable budget or none. Blocked identities wait while other eligible jobs proceed, with priority, weighted costs, cancellation, deadlines, and global concurrency leases.

  Fetch wrappers accept fixed identities or a synchronous resolver. Identities are copied once per logical request and reused across retries; every attempt reacquires all budgets. Missing required identities name the missing dimension and reject before queueing. Inactive Redis scope keys expire automatically.

  Scoped policies support up to 16 rules and 128 jobs per admission, with a default batch of 32. All keys for one Valve ID share a Redis Cluster slot. Custom stores must implement `acquireScoped`. Rule and scope changes require a coordinated configuration-fingerprint migration; limits cannot vary dynamically per identity. Provider feedback and pauses still affect the whole Valve ID. Admission does not guarantee provider delivery, and exact rolling windows remain unsupported.

  Include mixed-algorithm and multi-dimension examples, a Bottleneck chaining comparison, beta migration guidance, correctness tests across memory and Redis/Valkey, and reproducible benchmarks. Larger rule/batch combinations can increase Redis script latency and bundle size; see the scoped benchmark report for measurements and tuning guidance.

### Patch Changes

- Publish plain version numbers through npm's default channel, starting with 0.4.0. Install with `npm install valvejs`; Valve remains beta until 1.0, as stated in the READMEs and website. Remove prerelease mode and custom beta-channel publishing from release automation, and keep historical prerelease versions in the full package changelog. Website changelog and release lists show only plain-numbered versions. Update installation, contribution, release, and migration guidance to match.
- 52a3e0a: Remove hardcoded release numbers and planned-release wording from the repository and npm READMEs. Use an automatically updated npm badge and links to release history so installation guidance stays accurate across releases.

## 0.4.0-beta.0

### Major feature: atomic scoped rate limits

- 258d4e0: Add atomic scoped rate limits for requests that spend shared and per-identity budgets together. Named rules select recipient, tenant, or resource counters through per-job `scopes`; memory and Redis/Valkey stores spend every applicable budget or none. Blocked identities wait while other eligible jobs proceed, with priority, weighted costs, cancellation, deadlines, and global concurrency leases.

### Developer experience

- Fetch wrappers accept fixed identities or a synchronous resolver. Identities are copied once per logical request and reused across retries; every attempt reacquires all budgets. Missing required identities name the missing dimension and reject before queueing. Inactive Redis scope keys expire automatically.

### Limits and migration

- Scoped policies support up to 16 rules and 128 jobs per admission, with a default batch of 32. All keys for one Valve ID share a Redis Cluster slot. Custom stores must implement `acquireScoped`. Rule and scope changes require a coordinated configuration-fingerprint migration; limits cannot vary dynamically per identity. Provider feedback and pauses still affect the whole Valve ID. Admission does not guarantee provider delivery, and exact rolling windows remain unsupported.

- Include mixed-algorithm and multi-dimension examples, a Bottleneck chaining comparison, beta migration guidance, correctness tests across memory and Redis/Valkey, and reproducible benchmarks. Larger rule/batch combinations can increase Redis script latency and bundle size; see the scoped benchmark report for measurements and tuning guidance.

## 0.3.0-beta.1

### Patch Changes

- ddbeef0: Point the npm homepage and README documentation links to valvejs.vercel.app.
  Add npm beta-version and monthly-download badges, an explicit issue tracker,
  and package keywords.

## 0.3.0-beta.0

### Minor Changes

- d859290: Keep admitting jobs through a healthy store while optional notification subscription startup is pending. Shared rate limits and pauses remain enforced by the store, and subscription failures still emit store errors.
- 3f7dff2: Detect incompatible shared Redis/Valkey quota settings atomically during
  admission. A versioned fingerprint without a TTL covers normalized rate rules and
  global concurrency settings. Reported mismatches reject with `INVALID_OPTIONS`
  under every store-error policy, including `open`. Store outages and timeouts
  retain their existing policy behavior. Equivalent rule order and durations
  continue to share a budget. Document coordinated quota changes and the limits of
  rolling upgrades from versions without the guard. Reliable shared quotas and
  mismatch detection require a non-evicting Redis deployment; eviction can remove
  the fingerprint or active budget state.

### Patch Changes

- a4a60a1: Release cancelled queue entries during backpressure so repeated aborts and wait expirations cannot grow queue storage without bound.
- 55016dd: Bound automatic replay of inherited Request bodies to 64 KiB by default.
  Larger bodies are sent once, avoiding whole-upload buffering during retries.
  Use a finite `maxReplayBodySize` to adjust the byte limit, or `0` to send
  Request bodies once without probing. Small string and byte bodies still
  retry under the existing method policy. Explicit `init.body` overrides no
  longer clone the unused Request body; direct init streams remain single-use.
- 2950d2a: Honor the longest exhausted quota window when combining provider feedback readers, including conflicting IETF and x-ratelimit headers. Keep remaining/reset values paired within one reader and preserve explicit Retry-After precedence. Previously combine() selected the first remaining and reset independently; missing fields are now kept missing rather than borrowed from another quota. Standalone readers retain their parsing behavior.

## 0.2.0

### Minor Changes

- 0e878bc: Document provider quota scopes with examples for deliberate budget sharing and
  independent endpoint or model cooldowns. Clarify how Valve IDs and shared stores
  determine feedback isolation, with an executable sharing and isolation example.

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
