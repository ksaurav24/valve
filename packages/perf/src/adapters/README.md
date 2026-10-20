# Fair competitor adapters

All measurements are raw absolutes. `identity` invokes the job immediately and is
reported as a separate **harness floor** row. Nothing is subtracted, and no “net”
latencies or throughput are calculated. Identity does not claim to enforce any
quota, cancellation, or atomic contract. Its `supports()` accepts every workload
for measuring the floor; the V-only comparison matrix deliberately lists it N/A.

Versions are read from the installed package manifests: p-limit **7.3.3**,
p-queue **9.3.3**, Bottleneck **2.19.5**, ioredis **5.11.1**. No adapter options are
inferred from online documentation. Every dependency citation below is relative
to `packages/perf/node_modules/` and refers to that installed source.

| Category                                                                    | p-limit     | p-queue                                                     | Bottleneck                                                                                                                         |
| --------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| L1 ≤ C running locally                                                      | `pLimit(C)` | `{concurrency:C}`                                           | `{maxConcurrent:C}`                                                                                                                |
| L2 starts ≥ I/R apart                                                       | N/A         | `{interval:I/R, intervalCap:1, strict:true}`                | `{minTime:I/R}`                                                                                                                    |
| L3 ≤ R per own window                                                       | N/A         | `{interval:I, intervalCap:R, carryoverIntervalCount:false}` | `{reservoir:R, reservoirRefreshAmount:R, reservoirRefreshInterval:I}`                                                              |
| L4 burst bank                                                               | N/A         | N/A                                                         | **Approximate:** `{reservoir:B, reservoirIncreaseInterval:ceil(I/250)*250, reservoirIncreaseAmount:R, reservoirIncreaseMaximum:B}` |
| L5 queued cancellation                                                      | N/A         | per-job `{signal}`                                          | N/A                                                                                                                                |
| D1 global concurrency                                                       | N/A         | N/A                                                         | `{maxConcurrent:C, datastore:'ioredis', connection, id:quotaId}`                                                                   |
| D2 global pacing                                                            | N/A         | N/A                                                         | `{minTime:I/R, datastore:'ioredis', connection, id:quotaId}`                                                                       |
| D3 global window                                                            | N/A         | N/A                                                         | `{reservoir:R, reservoirRefreshAmount:R, reservoirRefreshInterval:I, datastore:'ioredis', connection, id:quotaId}`                 |
| V-only scoped, multi-rule atomic, weighted atomic, rate+lease, shared pause | N/A         | N/A                                                         | N/A                                                                                                                                |

`CATEGORIES` builds canonical cells and declares the control library (p-limit for
L1, p-queue for L3/L5, Bottleneck for L2/L4/D1/D2/D3). `registerAdapter()` lets the
lead add Valve without a dependency on the Valve adapter. `naMatrix()` derives
availability from each registered adapter's `supports()`, with the explicit
identity-floor exception above and an approximate annotation for Bottleneck L4.
Unsupported queue-capacity and fault-recovery comparisons are also N/A.

## p-limit

`p-limit/index.js:3-10,19-29,32-48` implements `pLimit(C)`, taking a slot before
starting a callback and releasing it on settlement, including failures. L1 has
no rate rule. It has no window, burst bank, Redis coordination, cost, priority,
queue-deadline, or AbortSignal mapping. `clearQueue()` on close discards queued
callbacks (`index.js:77-88`); promises for discarded jobs remain pending and the
harness records them as unserved. It does not masquerade as cancellation.

## p-queue

`p-queue/dist/index.js:57-88` verifies concurrency, interval, intervalCap,
carryoverIntervalCount and strict defaults. **Do not use
carryoverConcurrencyCount:** the constructor's false carryoverIntervalCount
default masks that deprecated alias in `index.js:57-81`.

L2 uses strict rolling counts with cap 1; tick pruning is in
`index.js:96-120,137-147,169-183`. L3 intentionally uses non-strict windows and
no running-job carryover (`index.js:269-281`); windows are anchored to queue
activity, not Valve's epoch windows. Check each library's own anchor. Higher
integer priority is passed through unchanged (`dist/priority-queue.js:22-30`).

L5 passes `signal` to `add`; queued abort listeners remove the callback and
reject (`dist/index.js:415-448`, `dist/priority-queue.js:41-54`). Adapter rejection
gets `code:'ABORTED'`, even when signal.reason is a primitive. Running abort also
races the callback promise (`dist/index.js:373-411`), so L5 compares **queued**
cancellation only; running resource accounting is not equivalent. This is also
why maxWait is N/A: `AbortSignal.timeout` would change running accounting.
`timeout` itself starts at execution (`index.js:39-43`), not queue admission.

Weighted cost, scopes, Redis and GCRA burst banks are N/A: rolling counts do not
represent a GCRA bank. Close uses pause/clear (`index.js:471-497`), discarding
queued callbacks; cleared promises remain pending. The strict timeout can remain
until an already-running callback settles (`index.js:484-494`).

## Bottleneck

`bottleneck/lib/Bottleneck.js:549-576` declares maxConcurrent, minTime,
reservoir refresh/increase options, datastore timers and connection.
`lib/LocalDatastore.js:142-153,206-226` checks capacity, debits weight from the
reservoir, increments running weight and advances the minTime schedule.

L3 and D3 use library-anchored **reservoir refresh** windows, not rolling or
Valve-epoch windows. Local refresh/increase is heartbeat-driven at 250ms
(`lib/LocalDatastore.js:29-54`, `lib/Bottleneck.js:562-570`); non-multiple periods
can refresh late. Redis refresh runs on script ticks/heartbeat (the bundled
`lib/lua.json` process_tick.lua entry; `lib/Scripts.js:5-12,58-63` and
`lib/RedisDatastore.js:48-64`). The Redis heartbeat defaults to 5000ms, so idle
refresh/notification can be late. These are safety quotas, not throughput
promises. No heartbeat tuning is applied.

L4 starts with B, adds integral R once per rounded-up interval, caps at B. This
is a coarse approximation, particularly when B < R (refill clips) or I is not
a multiple of 250ms. It does **not** implement GCRA's continuous refill, and
must never be reported as an exact GCRA comparison. The approximate flag is in
the matrix and cell notes. Fractional/nonpositive reservoir amounts are N/A.

Rate-only reservoir cells can map `weight=cost`. Weight also consumes
maxConcurrent (`lib/LocalDatastore.js:214-218`), so any weighted cell with
concurrency is N/A. Pacing alone does not multiply minTime by weight and is
therefore N/A for weighted rate cost. Weighted atomic / multi-rule mechanisms
remain Valve-only. Costs must fit the reservoir capacity to avoid unstartable
jobs. Rate plus concurrency/lease is not claimed as equivalent.

Priority mapping is `clamp(5 - trunc(priority), 0, 9)`: Valve higher-first becomes
Bottleneck lower-first, priority 0 maps to Bottleneck's default 5. It is
monotonic but collapses priorities outside Valve [-4,5]. The range/default are
in `lib/Bottleneck.js:31-32`, sanitization in `lib/Job.js:34-43`, and lower-first
dequeue in `lib/Queues.js:58-66`. Priority is local to each Bottleneck queue;
there is no global queue-priority guarantee across instances.

`expiration` is an execution timeout (`lib/Bottleneck.js:195-203`,
`lib/Job.js:169-173`), so maxWait is N/A. AbortSignal cancellation is N/A.

Pacing uses integer Date.now registration times and setTimeout callbacks
(`lib/LocalDatastore.js:212-222`, `lib/Bottleneck.js:191-203`). Actual callback
gaps can differ from minTime through quantization/timer jitter: a repeated Node
24 run observed 48.66ms at minTime=50ms. Bottleneck pacing tests allow 3ms of
observation slack (p-queue allows 1ms); no padding or library-specific tuning is
applied. This is not a hard real-time guarantee. Report callback timing in raw
records so tighter oracle tolerances can surface these differences.

### Redis connection ownership and isolation

Construct `client = new Redis(redisUrl)` using **ioredis 5.11.1**, then
`connection = new Bottleneck.IORedisConnection({client, Redis})`. URL parsing is
verified at `ioredis/built/Redis.js:664-676`; duplication at `:263-268`.
`bottleneck/lib/IORedisConnection.js:22-49` accepts the existing client and
creates its subscriber with `client.duplicate()`. Pass
`{datastore:'ioredis', connection, id:ctx.quotaId}` to the limiter
(`lib/Bottleneck.js:60-63,567-581`, `lib/RedisDatastore.js:29-54`). This avoids
Bottleneck resolving its optional ioredis dependency and never uses incompatible
node-redis 4+.

Each adapter instance owns a separate command/subscription pair; instances
sharing quotaId coordinate through `b_<quotaId>_*` keys
(`lib/Scripts.js:15-55`). Only loopback Redis URLs on ports 16479 and 16480 are
accepted. Quota IDs must contain only word characters, colon, dot, or hyphen.
No `clearDatastore` is set, and close does not delete shared state while other
instances might still use it. The trial owner must clean up **after all
instances close**, using SCAN MATCH `b_<quotaId>_*` and UNLINK only those keys;
the integration tests verify no owned keys remain after this cleanup.

Close is idempotent, never rejects, calls `stop({dropWaitingJobs:true})`
(`lib/Bottleneck.js:289-357,586-589`), disconnects the limiter, then explicitly
disconnects its owned connection. A provided connection is considered shared
and is not closed by limiter.disconnect (`lib/RedisDatastore.js:143-150`).
`lib/IORedisConnection.js:150-167` quits both clients; a failure falls back to
immediate disconnect. No Redis call instrumentation is added, avoiding an
extra wrapper in the measured competitor path; competitor store-call metrics
remain unavailable rather than invented.

No changes to Adapter/Limiter/AdapterContext are needed. Approximate support is
expressed by category notes and the matrix because supports() is true-or-reason.

### Verified runtime

Verified on Node **24.21.0**, ioredis **5.11.1**, and Redis **7.4.11** on
`127.0.0.1:16479`: all 17 local tests and all three clustered D1/D2/D3 tests
pass, including independent client pairs, global quota enforcement, connection
shutdown, and test-owned key cleanup. `npx tsc --noEmit` passes with strict,
noUncheckedIndexedAccess, and exactOptionalPropertyTypes enabled.

```sh
cd packages/perf
npx vitest run test/adapters.test.ts
PERF_INTEGRATION=1 npx vitest run --config vitest.integration.config.ts test/integration/adapters-redis.test.ts
npx tsc --noEmit
```
