# T1 admission model

This is a deterministic reference for **admission state**, written from the shipped
Redis Lua. It does not run or simulate Valve's scheduler, JavaScript microtasks,
network clients, timers, cancellation, deadlines, local concurrency, or callbacks.
The abstract client simulator explores its explicitly declared policy; it supplies
no evidence about Valve's scheduler or real throughput.

All admission functions accept fractional epoch milliseconds. They mutate only the
explicitly supplied `AdmissionState`; use `cloneState` for independent replays.
There is no ambient clock or randomness in admission or bounds. Requests are assumed
validated and policy-consistent, with unique lease owners; validation errors and
configuration ownership are outside this model's contract. `parity.ts` uses public
Store requests and compiles sparse references using `prepareScoped`'s key encoding.

- `state.ts`: GCRA TAT, fixed-window `(w,n)`, leases, and pause snapshots. GCRA expires
  at `ceil(TAT)`. Losing a GCRA key after TAT cannot affect admission because reads
  use `max(TAT, now)`. Static fixed-window keys expire after `ceil(2*interval)` from
  the integer server snapshot; scoped hashes expire at `ceil((w+1)*interval)`.
- `admission.ts`: static prefix grants, sparse atomic grants that skip denials,
  multi-rule atomic spending, weighted costs, lease slots, renewal/release, and
  extending pauses. Static checks leases before rates; sparse checks take the max
  of pause, rates, and lease hints, and attribute `leaseBlocked` by equality.
- `capacity.ts`: `ruleCapacity` is a long-run **cost** rate times window length,
  excluding the initial burst bank. Optional identity counts mean independent
  copies of the entire ruleset, not multiplication of shared global rules. Lease
  throughput is jobs/time, converted to cost using `opts.cost` (default 1).
  `idealBound` consumes an initial state snapshot and offered arrivals or saturated
  demand. It advances directly to eligibility, arrival, lease completion/expiry,
  or aligned-window events, without polling. Starts in `[t0,t1)` are counted;
  pre-window arrivals remain queued. Jobs hold leases until duration or TTL, whichever
  comes first. Missing duration means TTL-only ownership. `scopeKeys` supplies one
  identity per rule; use the same key for a shared rule. Unscoped jobs use static
  admission; scoped jobs use sparse admission, including its score-bound rounding.
  A denied scoped call that sweeps stale lease members can trigger an immediate
  zero-latency reattempt; those probes are not included in the grants list.
  The input snapshot is cloned. `prefix: true` also reports the difference from
  the skip-policy bound. This is a greedy policy comparison, not a weighted global
  optimum: skipping can sacrifice later high-cost jobs. The optimality assumptions
  for unit-cost FIFO jobs are stated next to the implementation.
- `sim.ts`: `simulate` runs N deterministic abstract clients, with one request in
  flight per client. Ties resolve by client index. Admission occurs at send time;
  a sampled RTT elapses before the reply, then the declared retry hint and sampled
  lateness delay the next call. Maintained backlog refills on reply. Open-loop
  arrivals are exogenous. Leases expire by TTL. Waits measure arrival-to-admission.
  Every result carries `kind: 'abstract-client-model'`. Zero-time client cycles and
  infinite instantaneous saturated bounds are rejected explicitly.

## Parity and clock control

`loadScripts` verifies the shipped source's SHA-1; `withInjectedClock` changes only
Redis TIME in the script bodies. Both acquire encodings and sparse JSON/fingerprints
match `redis/index.ts`. The trace runner reads server TIME once and chooses an epoch
1-2 million milliseconds ahead, aligned to one million milliseconds. Both the
model and Redis run at that exact epoch (important for fixed-window alignment).

Replacing TIME does **not** replace Redis key expiry or PTTL. Each script runs in a
wrapper with Redis's frozen real millisecond snapshot. The wrapper reconstructs the
virtual pause TTL in that same EVAL. Afterward the runner reads budget expiries and
persists the keys, then deletes only expired trace-owned budget keys before the next
call. Leases retain their scores and are swept by the shipped scripts. Static hash
TTLs remain relative to the real snapshot; the runner translates the observed TTL
into virtual time. These controls test admission math and expiry boundaries, not
real-server timing or expiry latency. Override `epochBase` only with a future epoch.

`renew.lua` loops through **all** arguments after TTL. An appended clock is therefore
an extra nonexistent token and makes raw validity false. A dedicated integration
case proves this artifact. The normal runner temporarily creates a member whose
name is the final clock argument, executes the exact injected renew script, and
removes that sentinel immediately in the same wrapper. It cannot collide with
Valve's `owner:index` tokens or become visible to admission. This preserves validity
for real tokens without changing the shipped loop or treating false as success.
The scoped script reads only its JSON argument and accepts the extra clock safely.

Only `redis://127.0.0.1:16479` and `redis://127.0.0.1:16480` are accepted. Each test
uses a UUID prefix. Cleanup uses `SCAN MATCH <prefix>:*` and `UNLINK` only; no flush,
container operations, or broad key deletion is performed.

Coverage includes generated fractional/integer static weighted-prefix traces,
nonintegral GCRA steps, state-derived exact eligibility and ±1 µs, fixed edges,
sparse identities with shared rules, generated scoped/lease/control traces,
expiry equality, renewal with partial loss, release, extending fractional pauses,
and lease attribution ties. Tightness tests first fill the bank, then replay every
constrained ideal grant against Lua and show that moving it 1 µs earlier is denied
(GCRA burst 1 and 3, fixed window, and joint rules). The initial unconstrained burst
cannot be denied by moving it earlier in an empty quota; it is seeded separately,
not claimed as a constrained tightness result.

## Independent memoryStore differences

The public `memoryStore({ clock })` is compared separately and is **not** an oracle.
The tests explicitly retain these differences:

1. **GCRA expiry representation:** memory uses `now + max(1,ceil(TAT-now))`, Lua
   uses `ceil(TAT)`. These can differ for fractional clocks. They both expire no
   earlier than TAT, so there is no admission-decision difference from this alone.
2. **Scoped fixed-window retention:** memory keeps hashes for `ceil(2*interval)`
   after spending; Lua expires them at the next aligned window. Reads reset counts
   when the window changes, so this changes retention, not valid-policy admission.
3. **Scoped lease retry:** memory includes same-call newly granted leases when
   finding the next expiry. Lua uses only the pre-call earliest live member, or
   `now+ttl` when there was none. If an existing slot was renewed to 201 ms, a new
   slot granted at 10 ms expires at 40 ms: the blocked job gets 191 ms from Lua and
   30 ms from memory. Grants and leaseBlocked still agree in this case.
4. **Fractional pause rounding:** memory stores `now+ms` and ceils the remaining
   duration. Redis starts `ceil(ms)` from its integer snapshot. Pausing at `.9 ms`
   for `1 ms`, then checking at `1.1 ms`, grants in Lua but remains paused in memory.
   Integer clocks and integer durations agree.
5. **Scoped lease score strings:** Lua 5.1's `'(' .. now` uses 14 significant digits
   for ZCOUNT/ZRANGEBYSCORE. At epoch-scale times it can round the score bound down
   or up. For example, a member expiring at `1792383000030.004` is still counted at
   that exact time because the string bound is `1792383000030`; the subsequent
   numeric sweep removes it. Memory uses full-precision `expiry <= now` and admits
   at equality. The model deliberately preserves Lua's read-before-sweep behavior.
   This can affect grants and retry attribution, and is covered by a direct memory
   divergence test plus generated real-server traces. Integer-ms traces agree.

Configuration mismatch/error validation and periodic memory ownership cleanup are
outside these decision comparisons. No production sources are modified.

## Verification

From `packages/perf`:

```sh
npx vitest run test/model.test.ts test/model-memory-parity.test.ts
PERF_INTEGRATION=1 npx vitest run --config vitest.integration.config.ts test/integration/model-redis-parity.test.ts
npx tsc --noEmit
```

Integration skips unless `PERF_REDIS_URLS` is set (comma-separated owned endpoints),
or `PERF_INTEGRATION=1` selects both owned endpoints. Missing servers under explicit
integration opt-in fail rather than silently skip.
