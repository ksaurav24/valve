# RFC: `@valve/perf`, the Valve performance and correctness harness

Status: revision 4 (integrated with valvejs 0.5.2; verification is recorded in IMPLEMENTATION.md). Supersedes the design-only RFC posted in the
architecture thread on 2026-10-19. This revision resolves eight review blockers, each checked
against the source at `1979020` (valvejs 0.5.0). Sections marked **Decision** are binding for the
implementation. The build checklist in section 12 tracks delivery.

## 0. Summary

`packages/perf` is a private workspace package. It adds no runtime dependency to `valvejs` and
never edits `packages/valve/src`. It consumes built artifacts of a named git ref and measures them
through public seams:

- the `Store` interface;
- the `redisStore({ adapter })` evalsha seam;
- timestamps taken inside the job body;
- Redis `INFO`;
- instrumented copies of the shipped Lua, used only in correctness arms.

The harness has five tiers:

| Tier              | Command                                   | What it is                                                                                                                                                             | What it is not                            |
| ----------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| T0 micro          | `perf micro`                              | tinybench in-process costs                                                                                                                                             | No distributed or Lua claims              |
| T1 model          | `perf model`                              | Pure admission-state reference model with tested parity to Redis Lua, capacity and ideal-supply bounds, an abstract-client discrete-event simulator, oracle self-tests | **Not** a simulation of Valve's scheduler |
| T2 smoke          | `perf smoke`                              | Real-time Valve with memory and real Redis/Valkey, every mechanism, correctness oracles, a few seconds per cell                                                        | No performance gates                      |
| T3 matrix         | `perf matrix --profile …` and `perf libs` | Paired A/B/A-A comparisons, risk and covering cells, staged sequential replication, competitor categories                                                              | No claims across fingerprints             |
| T4 soak and chaos | `perf soak` and `perf chaos`              | Long windows, leak slopes, restart, pause, kill, churn, stall                                                                                                          | Full durations run only on request        |

Every result carries two statuses that are never merged:

- an absolute **safety status**: `PASS`, `FAIL` or `UNVERIFIED`;
- a **performance status** per metric and cell: `REGRESSION`, `IMPROVEMENT`, `NONINFERIOR`,
  `EQUIVALENT`, `INCONCLUSIVE`, `UNSTABLE` or `DESCRIPTIVE`.

## 1. Blocker 1: T1 validity. Decision: T1 is an admission-state model, not a virtual-time Valve

**Source check.** Valve reads several runtime facilities directly as globals:

- `Date.now()`: `valve.ts:138,226,274,330,334,481,570,590,653,790,802,840`; `leases.ts:49,54,70,79,119`
- `performance.now()`: `valve.ts:411,702`
- `setTimeout`: `valve.ts:132,181,804,815`; `leases.ts:44,70`
- `queueMicrotask`: `valve.ts:124,290`; `leases.ts:131`; `memory-store.ts:37`
- `Math.random`: `valve.ts:143,152`
- `crypto.randomUUID`: `valve.ts:101`

In addition:

- Redis I/O goes through real sockets (ioredis or node-redis).
- Jobs run in microtasks whose ordering against promise resolution depends on the engine's job queue.

A complete virtual-time runtime would have to replace all of these globals for the library and
the client libraries, and it would have to control how promise jobs interleave with faked timers.
That is not possible without patching production code or the runtime. The `@sinonjs/fake-timers`
approach controls timers but not socket I/O, and it does not stop native promise jobs from
interleaving. **We do not build a "deterministic Valve".**

**Decision.** T1 has four parts:

1. **Reference admission model** (`src/model/`). A pure TypeScript re-implementation of the
   admission semantics of `acquire.lua` and `scoped.lua`, written from the Lua and not from
   `memoryStore`. It covers:
   - GCRA with burst and the per-job prefix grant;
   - fixed windows aligned to `floor(now/interval)`;
   - several rules spent atomically;
   - weighted costs with head-of-line prefix blocking (`acquire.lua:48-83`);
   - scoped all-or-nothing admission per job, where a denial does not block later jobs
     (`scoped.lua:68-99`);
   - lease slots with TTL, renewal and release, including the `leaseBlocked` attribution;
   - pause.

   Time is a fractional millisecond value, as with Redis `TIME`. The model is deterministic by
   construction because it is a pure function of its inputs.

2. **Parity proofs.** Generated traces, including boundary-targeted ones, run through three
   implementations: the model, `memoryStore({ clock })` and **real Redis or Valkey executing the
   exact shipped script**. The script's only change is `redis.call('TIME')` replaced by an
   injected clock. This is the same transformation as `test/lua-clock.ts`, and the source is
   verified by SHA-1 against `scripts.ts` of the same build.

   Boundary generators target:
   - eligibility instants `t = TAT - (burst-cost)·step` and `t ± 1e-3`;
   - window edges `k·interval` and `k·interval - 1e-3`;
   - `PXAT` expiry instants;
   - lease expiry equality (`ZREMRANGEBYSCORE -inf now` removes `expiry == now`);
   - integer versus fractional clocks.

   Every decision must match: grants, `retryAfterMs`, lease tokens, `leaseBlocked`, and blocked
   indexes for scoped requests. Known divergences of `memoryStore` (an integer `Date.now` clock and
   a different expiry formula, `algorithms.ts:46` versus `acquire.lua:91`) are listed and tested
   as documented divergences. `memoryStore` is therefore **not** treated as an oracle. The model is
   checked against Redis, and the memory store is checked against the model.

3. **Capacity and ideal-supply bounds** (section 2), computed by the model and validated against
   Lua. A greedy admission schedule replayed against the clock-injected script must be granted
   in full. Moving each grant 1 µs earlier must be denied, which proves the bound is tight.

4. **Abstract-client discrete-event simulator** (`src/model/sim.ts`). N clients follow a
   _declared_ policy (retry at the hint, a sampled RTT distribution, a sampled timer-lateness
   distribution, batch size) against the model. Its output carries the label
   `abstract-client-model`. It is used for policy exploration and for self-tests of the oracles
   and metrics on traces with known answers. It is never used as evidence about Valve.

**Valve scheduler behavior** (timers, microtasks, wakeups, herd, `maxWait`) is measured only with
real time: memory-store cells and real Redis/Valkey cells in T2, T3 and T4.

## 2. Blocker 2: no bias in the utilization denominator. Decision: separate quantities, offered schedules, labelled bounds

Each measured window `[t0, t1)` reports these quantities separately. All are in cost units unless
marked as jobs.

| Quantity                                          | Definition                                                                                                                                                                                                                                                                                                                             | Source                             |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `offered`                                         | Cost whose **intended** arrival time (from the precomputed seeded schedule) falls in the window. Also counted in jobs.                                                                                                                                                                                                                 | Schedule, generated before the run |
| `ruleCapacity`                                    | The rules' long-run rate times the window length. For several rules, the minimum. For scoped rules, summed over active identities. For leases, `limit × window / meanDuration` when duration is known.                                                                                                                                 | Closed form (`model/capacity.ts`)  |
| `idealBound`                                      | Cost admitted by a **zero-latency, perfectly timed, greedy** admitter running the model over the **offered** schedule, starting from the **measured initial store state** at `t0` (TAT `GET`, window `HMGET`, lease `ZRANGE`). For saturated backlog cells the demand is infinite, so the bound becomes the capacity given that state. | Model                              |
| `idealBoundNonPrefix`                             | The same, but allowed to skip a blocked head job. The difference from `idealBound` is head-of-line loss.                                                                                                                                                                                                                               | Model                              |
| `admitted`                                        | Server-logged grants (correctness arms) or client-counted grants (performance arms). Both are reconciled when present.                                                                                                                                                                                                                 | Lua log or adapter                 |
| `usefulStarts`                                    | Callbacks that actually started, measured in the job body                                                                                                                                                                                                                                                                              | Worker                             |
| `completions`                                     | Jobs that settled successfully in the window                                                                                                                                                                                                                                                                                           | Worker                             |
| `deadlineSuccess`                                 | Among jobs with a deadline, the fraction that **started their callback** at or before the deadline                                                                                                                                                                                                                                     | Worker                             |
| `expired`, `rejected`, `aborted`, `unservedAtEnd` | Terminal and censored outcomes (section 3)                                                                                                                                                                                                                                                                                             | Worker                             |

Ratios reported, each under its own name:

- `boundEfficiency = admitted / idealBound`;
- `capacityUtilization = admitted / ruleCapacity`;
- `goodput = usefulStarts / offered`.

**The bound is not attainable.** It assumes no RTT, no timer error and no CPU cost. Reports say
so, and they report the bound's input state.

**Open loop versus closed loop.**

- _Open-loop_ cells use precomputed offered schedules: Poisson, periodic with random phase,
  bursty on/off, cron surge, ramp, and uneven per worker. Arrival times never depend on system
  responses. Each submission records its lag behind the intended time, and lag over 5 ms is
  reported as **generator saturation**, which invalidates the cell.
- _Saturated closed-loop_ cells (a maintained backlog of depth D) have demand that never runs
  out, so the bound is independent of the system's speed. `backlogMinDepth` is recorded to prove
  the backlog never drained.
- _Finite closed-loop_ cells (C concurrent issuers with think time) have **demand that depends
  on the system**. These cells report throughput, latency and `capacityUtilization` only. No
  `idealBound` ratio is computed, and reports state that the denominator is not exogenous.

**Validating the capacity models** (unit tests against brute force, plus Redis parity):

| Mechanism         | What is validated                                                                                                             |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| GCRA with burst B | Window count `ceil(T/step)+B-1` from a full bank; steady state from an empty bank; refill after idle.                         |
| Fixed window      | Aligned windows, with a partial first window using the measured count, and the boundary pair up to 2×limit.                   |
| Several rules     | The greedy joint schedule (the bound is _not_ the minimum of each rule's bound when phases differ).                           |
| Scoped rules      | Independent identities, plus rules shared across identities.                                                                  |
| Weighted prefix   | Blocking of later jobs behind a large head job.                                                                               |
| Leases            | Occupancy over time with known job durations. Capacity held by a crashed worker until its TTL expires is reported separately. |

**Uncertainty.** The bound inherits the error of the initial-state snapshot, which is taken by a
separate Redis call at `t0` and so lags the window edge by up to one RTT. That error is reported
as `boundStateLagMs`. Server-side bounds are exact only for correctness arms. Performance arms
use client counts, whose window edges are uncertain by ±RTT/2.

## 3. Blocker 3: latency and statistics. Decision: censoring, competing risks, independent replications, preregistered staged tests

**Outcomes.** Each submitted job ends in exactly one class:

| Class           | Meaning                                                                                                  |
| --------------- | -------------------------------------------------------------------------------------------------------- |
| `started`       | Then `completed` or `failed`                                                                             |
| `expired`       | `MAX_WAIT_EXCEEDED`                                                                                      |
| `aborted`       | `ABORTED`                                                                                                |
| `rejected`      | `QUEUE_FULL`, `CLOSED` or `STORE_UNAVAILABLE`                                                            |
| `unservedAtEnd` | Still queued at observation end. **Right-censored at `observationEnd - intendedArrival`, not infinite.** |
| `lost`          | No terminal outcome after close. **This is a safety failure.**                                           |

Counts are always reported next to any latency distribution.

**Time to start.** Three labelled views:

1. `conditional`: percentiles over started jobs only. The label says "conditional on starting".
2. `cif`: an Aalen-Johansen cumulative-incidence estimate of _start_, with `expired` and
   `rejected` as competing risks, and with `aborted` and `unservedAtEnd` as right-censoring.
   Treating aborts as non-informative censoring is an assumption, and reports state it. The q-th
   quantile is `inf{t : CIF_start(t) ≥ q}`, and is reported as **not reached** when the
   cumulative incidence never gets to q.
3. `failureRanked`: a conservative label in which every non-started outcome counts as worse than
   any wait. This is the old "∞" view, renamed and labelled.

The Kaplan-Meier and Aalen-Johansen implementations are tested against golden values generated
by `lifelines` (`AalenJohansenFitter`, `KaplanMeierFitter`), produced once by
`scripts/golden/generate.py` through `uv` and committed as fixtures.

**Replication.**

- A replication (rep) is an _independent trial_: fresh processes, fresh store state (a flush
  guarded by the disposable-endpoint check, or a fresh key prefix) and fresh seeds.
- Arms in one rep share the workload seed. That is the pairing unit.
- Arm order is rotated across reps, and cell order is shuffled per rep with a seeded shuffle.

**Inference.**

- Use the per-rep paired difference `d_i = arm_i - base_i`. The primary interval is the
  Student-t interval on `mean(d)`. The t-quantile comes from `@stdlib/stats-base-dists-t-quantile`
  and is golden-tested against `scipy.stats.t.ppf`.
- A sign-flip permutation p-value serves as a robustness check: exact enumeration up to n=16,
  seeded Monte Carlo above that. It is golden-tested against `scipy.stats.permutation_test`.
- No confidence statement is made below n=5. Those cells are `DESCRIPTIVE`, and their
  differences are shown without intervals.
- **No bootstrap below n=20.** Percentile bootstrap intervals are not reported at all in v1.

**Sequential design (decision profile).**

- Looks are preregistered at n = 5, 10 and 20 reps per cell. The two-sided alpha is split
  across all declared cell/metric families within each suite and equally across looks
  (Bonferroni, α/(suite comparisons × looks) per interval), which bounds error over the whole sequence
  without spending functions.
- At each look, for a metric where higher is better and margin m:

  | Condition on the interval            | Verdict       |
  | ------------------------------------ | ------------- |
  | Upper bound < -m                     | `REGRESSION`  |
  | Lower bound > -m and upper bound < m | `EQUIVALENT`  |
  | Lower bound > m                      | `IMPROVEMENT` |
  | Lower bound > -m                     | `NONINFERIOR` |

- Sampling stops at a look only when every metric in the cell's preregistered set has a
  non-`INCONCLUSIVE` verdict. After the last look, anything still open is `INCONCLUSIVE`.
- Margins, the metric set, looks and alpha are written to the run manifest **before** the first
  trial and hashed. Changing them invalidates resumption.

**A/A.**

Jain fairness is not a decision metric for single-worker cells; applicability is fixed during
planning. An inapplicable metric must not leave an otherwise valid A/A control unresolved.

- Every paired matrix cell includes an A/A arm, the same artifact in separate processes.
  Library categories include Valve A/A; one-arm smoke, soak, and chaos do not make A/B claims.
- If the A/A interval at the final look does not contain 0, or extends beyond ±m, the cell is
  `UNSTABLE`. Its A/B verdicts are downgraded to `INCONCLUSIVE`, with the reason recorded.

**Multiplicity.** Within a suite, `REGRESSION` flags across cells are additionally controlled
with conservative Bonferroni intervals. Holm-adjusted sign-flip p-values are additional
robustness diagnostics against zero difference, not tests against the practical margin.

**Failures are not noise.** Safety violations, lost jobs, crashed workers and resource-invalid
trials are never folded into performance uncertainty. Resource-invalid trials are kept, flagged
and repeated up to 3 times, and a sensitivity table includes them.

## 4. Blocker 4: the inherited `maxWait` gap is a safety failure

**Historical source check (0.5.0).** `start()` checks `job.deadline <= Date.now()` (`valve.ts:274`) when the store
reply is handled. The callback runs later in a microtask (`valve.ts:290`), after the other
callbacks granted in the same batch. With synchronous work in an earlier callback of the batch,
or an event-loop stall between the check and the microtask, the callback can start after its
deadline. Prior evidence: forced 21-26 ms late; 3 natural cases of at most 0.26 ms
(`SLOTEXP_PRODUCTION_VALIDATION.md` §2).

**Decision.**

- The client oracle classifies every callback start after `submit + maxWait` (on the monotonic
  clock) as a violation:
  - `C1-check-before-deadline` when the grant reply was handled before the deadline;
  - `late-grant` otherwise.
- Any violation makes the arm's safety status **FAIL**. Reports print the safety status before
  any performance verdict. No suite is called passing while it has a C1 violation. The status
  reads `FAIL (C1 × n)`, and the regression status is reported separately.
- C1 was fixed in valvejs 0.5.2 by [PR #101](https://github.com/ksaurav24/valve/pull/101).
  `perf c1` now verifies deadline rejection: the blocking job must finish, its stall must cross
  the later deadline, and the later job must reject with `MAX_WAIT_EXCEEDED` without starting.
  A verified check exits 0; a late callback exits 1; unrelated rejection or missing coverage
  exits 2. Unit and Redis/Valkey integration tests assert the fixed behavior.
- Every deadline violation stops execution and makes safety FAIL. Historical vulnerable builds
  keep `KNOWN DEFECT REPRODUCED` labels; missing historical evidence is not upgraded to PASS.
- [Issue #100](https://github.com/ksaurav24/valve/issues/100) is closed as fixed. The harness
  consumes that upstream production fix and does not introduce another production change.

## 5. Blocker 5: execution budgets. Decision: measured cost model, budgets enforced by dry run

**Measured legacy costs** (2,136 slotExp trials, `durationSec - window`). Per-trial overhead
(spawn, warmup, guard quiet period, flush, drain, teardown) has these medians:

| Workers | Median overhead |
| ------- | --------------- |
| 1       | 2.5 s           |
| 8       | 2.6 s           |
| 32      | 3.3 s           |
| 64      | 4.0 s           |

The p90 is at most 5.1 s. Resource rejections ran at 2.4%, each adding the trial time plus 10 s
of cooldown. The 2,048 attempts averaged 9.3 s of wall time each, including 4-5 s measurement
windows.

**Cost model.**

```
trial_s = warmup_s + window_s + drain_s + overhead(workers)
overhead(w) = a + b·w + quiet
```

`a`, `b` and `quiet` are calibrated per host by `perf calibrate`. The defaults come from the
legacy medians above (a=2.3, b=0.027, quiet=2.0).

```
expected_total = Σ trial_s × (1 + rejectRate) + rejectRate × cooldown + infra_setup + report_s
```

**Profiles.** `perf plan --profile X` prints cells, trials and the estimate before anything runs.
Runs whose estimate exceeds 60 minutes require `--yes`.

| Profile         | Contents                                                                                                     | Target wall time                    | Cadence                     |
| --------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------- | --------------------------- |
| `quick`         | micro (reduced iterations) + model + oracle self-tests                                                       | under 90 s on a laptop              | local and PR                |
| `smoke`         | About 22 cells, 1 rep, base arm only, 1.5 s windows, Redis 7.4 + Valkey 8, plus memory cells                 | measured in CI (section 12)         | PR, path-filtered           |
| `targeted`      | Risk cells of one suite, 3 arms, 5 reps                                                                      | estimate printed; usually 15-30 min | developer on demand         |
| `sylvie`        | Two workers; rate and lease cells; 3 arms, 10 fixed pairs, 15 s windows, separate correctness audits         | about 21 min on i5-12450H           | quiet local laptop          |
| `nightly`       | Budget-bounded (`--budget`, default 40 min): risk cells by priority until the budget is used, 3 arms, 5 reps | ≤ budget                            | nightly on a dedicated host |
| `decision`      | All suites' risk and covering cells, staged looks 5/10/20                                                    | multi-hour, printed                 | manual or release candidate |
| `soak`, `chaos` | 1-12 h and fault scripts                                                                                     | printed                             | manual or weekly            |

Speed choices:

- `sylvie` keeps the existing margins and A/A rules, selects separate fast physical cores,
  and requires a protected 3 GiB process scope with no swap. It provisions one pinned store
  when needed and removes only what it created. The resource guard requires 4 GiB available
  before trials, 2 GiB during trials, and no more than 2 GiB process memory. This is focused
  rate/lease coverage; the broader profiles remain available for other mechanisms and fleets.

- Workers stay warm inside a trial but are never reused across trials.
- Rate-decision windows use at least 40 eligibility slots and at least 1.5 s. Local L1/L1-noop
  overhead diagnostics use uniform 100 ms windows to bound deep-backlog recording and do not
  support distributed performance claims.
- `--budget` truncates by priority, never by random cut.
- Quick tiers avoid Docker entirely.

## 6. Blocker 6: scoring and fair comparisons. Decision: raw absolutes, overhead as its own row, N/A where semantics differ

- Every result reports raw absolutes. An `identity` adapter, which calls the function directly,
  is reported as its own row, the **harness floor**. **Nothing is subtracted from anything.**
  Async scheduling costs do not add up, so "net" numbers are not computed.
- Competitor versions are pinned (`p-limit 7.3.3`, `p-queue 9.3.3`, `bottleneck 2.19.5`) and
  written to every manifest.
- Each competitor's configuration is derived from verified API semantics, cited in
  `src/adapters/README.md`. For example, p-queue's deprecated `carryoverConcurrencyCount` alias
  is masked by the `false` default in 9.3.3 (`dist/index.js:57-81`), so the adapter uses
  `carryoverIntervalCount`.
- All libraries get the same job bodies, the same offered schedules, the same warmup policy and
  cold processes. No adapter gets library-specific tuning beyond that library's documented
  configuration for the category's contract.

| Category                          | Contract                                                                     | Valve                                            | p-limit     | p-queue                                                        | Bottleneck                                   | Control                           |
| --------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------ | ----------- | -------------------------------------------------------------- | -------------------------------------------- | --------------------------------- |
| L1 local concurrency              | ≤ C running locally                                                          | memory store, `concurrency: C`, **no rate rule** | `pLimit(C)` | `{concurrency: C}`                                             | `{maxConcurrent: C}`                         | p-limit                           |
| L2 local burst-1 pacing           | starts ≥ I/R apart                                                           | GCRA burst 1, memory                             | N/A         | `{interval: I/R, intervalCap: 1, strict: true}`                | `{minTime: I/R}`                             | Bottleneck                        |
| L3 local fixed-window quota       | ≤ R per window (anchoring differs)                                           | fixed window, memory                             | N/A         | `{interval: I, intervalCap: R, carryoverIntervalCount: false}` | reservoir refresh R / I                      | p-queue                           |
| L4 local burst bank               | ≤ R + B − 1 per window                                                       | GCRA burst B                                     | N/A         | N/A (rolling count, not GCRA)                                  | reservoir increase, capped at B              | Bottleneck (labelled approximate) |
| L5 queued cancellation            | aborted queued jobs never start                                              | `signal`                                         | N/A         | `signal`                                                       | N/A                                          | p-queue                           |
| D1 distributed global concurrency | ≤ C running across processes                                                 | global lease, Redis                              | N/A         | N/A                                                            | Clustering `{maxConcurrent: C}` with ioredis | Bottleneck                        |
| D2 distributed burst-1 pacing     | starts ≥ I/R apart globally                                                  | GCRA burst 1, Redis                              | N/A         | N/A                                                            | Clustering `{minTime}`                       | Bottleneck                        |
| D3 distributed window             | ≤ R per window globally                                                      | fixed window, Redis                              | N/A         | N/A                                                            | clustered reservoir refresh                  | Bottleneck                        |
| V-only                            | scoped, several atomic rules, weighted atomic, rate plus lease, shared pause | Valve                                            | N/A         | N/A                                                            | N/A                                          | -                                 |

Competitor concurrency and queued cancellation are checked against each library's observable
contract. Pacing uses declared timer/alignment tolerances (1 ms for p-queue; 3 ms locally and
3.5 ms distributed for Bottleneck). Fixed-window callback traces use a two-window envelope
because an interval can straddle the library's own window boundary. These are coarse diagnostics:
exact reservation/window clocks remain `UNVERIFIED`. Valve's GCRA and epoch-window grant
semantics are never imposed on competitors. L5 cancels only jobs that are still queued.

Library analysis pairs seeds by category, with L1-noop separate from asynchronous L1. Valve gets
independent A/A trials. Identity and approximate L4 Bottleneck rows remain raw descriptive
values; eligible comparisons require five complete pairs and stable A/A. Interval alpha is split
across all planned categories, arm families, metrics, and looks before execution.

## 7. Blocker 7: dependencies, portability, safety

- **Reuse.** Ported to TypeScript with attribution, behavior kept, made configurable:
  - slotExp `resources.mjs` policy v5;
  - `worker.mjs` workload patterns;
  - `run.mjs` `windowMetrics` and `safety`;
  - fault primitives (iteration-count stall, client kill, CPU load);
  - `baseline/scripts/lib.mjs` `countingAdapter` and Jain.
- **Python.** The legacy Python analyzers are not rewritten in place. They stay in the archive,
  and are run on the extracted legacy rows to produce golden outputs. The TypeScript analyzer
  must reproduce those outputs (`test/legacy-golden.test.ts`) before its numbers are trusted.
- **Authoritative versus portable.**
  - Authoritative runs require Linux, cgroup v2 with delegated memory and cpu (a
    `systemd-run --user` scope with `MemoryMax` and `MemorySwapMax=0`), `taskset` CPU sets,
    servers pinned with `--cpuset-cpus`, and direct container IPs.
  - Without those, the run is marked `authoritative: false` and its reports carry a banner.
    Quick and model tiers run anywhere Node runs.
- **Destructive operations.** `FLUSHDB` is allowed only on an endpoint that:
  1. was created by `perf infra up` (Docker label `dev.valve.perf=1`), or was adopted with
     `perf infra adopt <url> --empty-only` (requires `DBSIZE == 0`); and
  2. holds the sentinel key `__valve_perf_disposable__` whose value equals the token recorded
     in `.perf/infra.json`.

  Every other endpoint runs in **prefix mode**: a unique per-trial key prefix, and cleanup that
  only `SCAN`s and `UNLINK`s keys under that prefix. The harness never issues `FLUSHALL`.

- **Provenance.** Every run records:
  - a run ID and a manifest with build identities (git SHA, patch SHA, SHA-256 of every `dist`
    file and of the lockfile, Lua SHAs);
  - an environment fingerprint (CPU model and topology, governor, kernel, Node, Docker, server
    image digests, network path, timer-lateness profile, cgroup capability);
  - suite, cell, plan and margin hashes, and seeds.

  Resumption requires every one of these to be identical. Stale or mismatched rows are refused,
  and nothing is silently reused. Runs live under `.perf/runs/<runId>/`, which is git-ignored.

## 8. Blocker 8: evidence preservation (done before any change)

- Archived to `/home/xlr8/valve-evidence-archive/2026-10-19-pre-harness/`:
  - `bench.tar.zst` (1.14 GB);
  - a per-file SHA-256 manifest (6,906 files);
  - git status at archive time.

  Verified by full extraction with every file hash matching, then made read-only.

- No legacy file is deleted or rewritten in this work. Retiring legacy scripts is a later, separate
  change that requires this archive. The existing `bench.yml` gate stays as it is.
- Work happens in a T3-bound worktree (`feat/perf-harness`). The main checkout's unrelated
  uncommitted edits (`.gitignore`, `AUDIT.md`, `test/audit/`) are untouched. The local branch
  `chore/prune-bench-artifacts` (which deletes tracked raw results) is not merged.

## 9. Mechanism suites and coverage

| Suite          | Mechanisms                                                                  | Workloads                                                         | Oracles                                    | Tiers                      |
| -------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------ | -------------------------- |
| `gcra`         | burst 1 and N, quotas 10-2,000/s, 1-64 workers                              | backlog, Poisson 0.3/0.7/0.95, cron surge, uneven, idle-to-active | rate bound (server), deadline, abort, lost | T1, T2, T3                 |
| `fixed-window` | aligned windows, boundary bursts                                            | backlog, boundary-phased surge                                    | per-window bound, boundary pair            | T1, T2, T3                 |
| `multi-rule`   | e.g. 10/s plus 300/min, GCRA plus fixed window                              | backlog, Poisson                                                  | each rule                                  | T1, T2, T3                 |
| `scoped`       | tenant identities, shared plus scoped rules                                 | skewed tenant mix, independent keys                               | per-identity bounds, non-blocking denials  | T1, T2, T3                 |
| `weighted`     | cost mixes (1/8, 1/50)                                                      | backlog with heavy heads                                          | cost-weighted bound, head-of-line loss     | T1, T2, T3                 |
| `lease`        | global concurrency, subscriber on and off                                   | durations 5/50/500 ms, sync CPU                                   | occupancy replay plus client overlap       | T1, T2, T3, T4             |
| `combined`     | rate plus lease                                                             | backlog                                                           | both                                       | T2, T3                     |
| `deadlines`    | maxWait mixes, urgent cohorts, abort races                                  | urgent-behind-backlog, abort before, in-flight, after grant       | C1 classification, abort                   | T1, T2, T3                 |
| `stores`       | Redis 6.2/7.4/8, Valkey 7.2/8 (correctness); 7.4 and Valkey 8 (performance) | backlog                                                           | all                                        | T2, T3                     |
| `lifecycle`    | worker join and leave, crash, cold start                                    | churn                                                             | progress, lease expiry within TTL          | T3, T4                     |
| `faults`       | restart, pause beyond TTL, client kill, Lua stall, CPU and command load     | backlog                                                           | safety and recovery time                   | T4 (one cell in T2)        |
| `runtime`      | `bgloop`, sync CPU, event-loop delay, timers                                | backlog                                                           | all                                        | T3                         |
| `network`      | RTT 5±2 and 25±8, fixed delay only paired with jitter, loss                 | backlog, Poisson                                                  | all                                        | T3 (needs the netem image) |
| `libs`         | L1-L5, D1-D3                                                                | same schedules                                                    | each library's contract                    | T3                         |

**Not covered, and declared:**

- multi-host fleets, because there is one host;
- Redis Cluster performance (the instrumented scripts touch an undeclared log key, so
  correctness arms refuse cluster mode);
- Sentinel and TLS;
- more than 64 processes on this host.

## 10. Metrics

| Metric                                                                                                               | Unit                                                                                                                          | Source              |
| -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `offered`, `ruleCapacity`, `idealBound`, `idealBoundNonPrefix`, `admitted`, `usefulStarts`, `completions`            | cost and jobs per second                                                                                                      | as in section 2     |
| `boundEfficiency`, `capacityUtilization`, `goodput`                                                                  | ratios                                                                                                                        |                     |
| Outcome counts                                                                                                       | jobs                                                                                                                          |                     |
| Wait percentiles p50/p95/p99/p99.9, in the three labelled views                                                      | ms                                                                                                                            |                     |
| Calls per grant (acquire), scripts per useful job (all), zero-grant calls per grant                                  | ratios                                                                                                                        |                     |
| Server-log split of zero grants into `early` (sent before the eligibility implied by the last state) and `lost-race` | ratio                                                                                                                         | correctness arms    |
| Redis CPU per grant                                                                                                  | µs                                                                                                                            | `INFO cpu`          |
| Evalsha µs per call                                                                                                  | µs                                                                                                                            | `INFO commandstats` |
| Commands per second                                                                                                  | /s                                                                                                                            |                     |
| App CPU per grant, max RSS, heap, event-loop delay p99 at 10 ms resolution                                           |                                                                                                                               |                     |
| Fairness                                                                                                             | Jain over equal-demand backlogged workers, minimum share, longest no-start gap; uneven cells report a demand-normalized share |                     |
| Lease                                                                                                                | occupancy maximum, oversubscription, capacity held by crashed workers                                                         |                     |
| Deadlines                                                                                                            | success rate, C1 count, worst lateness, grant-to-callback gap p99 and max                                                     |                     |
| Wasted grants                                                                                                        | %                                                                                                                             |                     |
| Generator lag                                                                                                        | p99, plus saturation flag                                                                                                     |                     |
| Instrumentation overhead                                                                                             | paired instrumented versus uninstrumented cells                                                                               |                     |

Clock rules:

- Redis `TIME` is the authority for server events.
- The monotonic clock is used within a process.
- On one host, `performance.timeOrigin + now()` is used across processes. Alignment is
  revalidated each run: the fraction of server timestamps inside the client `[send, reply]`
  window is reported.
- Wall clocks are never compared across hosts.

## 11. Commands

```
pnpm perf doctor                    host checks → fingerprint
pnpm perf calibrate                 measure trial overhead → .perf/calibration.json
pnpm perf infra up|down|status|adopt|images
pnpm perf build [--ref <git-ref>] [--patch <file>]   artifact + identity
pnpm perf micro | model | quick
pnpm perf smoke [--stores redis74,valkey8] [--suite …]
pnpm perf plan --profile targeted|nightly|decision [--suite …] [--budget 40m]
pnpm perf matrix --profile … --base <ref> [--head <ref>|--current] [--yes]
pnpm perf libs [--category L1,L2,…,D3] [--reps 5]
pnpm perf soak --duration 4h [--suite lease]  |  pnpm perf chaos [--faults …]
pnpm perf c1                        reproduce the inherited deadline gap
pnpm perf report <runId> [--html]
pnpm perf legacy catalog|golden
```

## 12. Build and test checklist

The implementation status of each item, with evidence, is recorded in `IMPLEMENTATION.md`.

- [x] Package scaffold, `.perf` ignore, root script, typecheck and lint integration
- [x] `core`: codec (reserved object tags for non-finite numbers, preserving literal strings), IDs and hashes, seeded RNG and distributions, fingerprint, manifest, paths
- [x] `identity`: current and ref builds via a git worktree, patch builds, SHA-256 manifest, Lua sources verified by SHA
- [x] `infra`: labelled containers, pinning, direct IP, sentinel guard, adopt, prefix cleanup, netem images, faults
- [x] `lua`: instrumented builder (log key) for acquire, scoped, release and renew; clock-injected builder; log parser
- [x] `model`: GCRA, fixed window, several rules, weighted prefix, scoped, lease, pause; capacity and ideal bounds; abstract simulator
- [x] Model parity tests: against `memoryStore` (unit) and against Redis/Valkey Lua (integration, with boundary generators), plus bound-tightness proof
- [x] `workload`: offered schedules (Poisson, periodic, bursty, cron, ramp, uneven), job durations and costs, deadlines, abort plans, closed-loop backlog, finite clients
- [x] `driver`: worker process, barrier, streaming recorder with bounded memory, store and eval instruments, event-loop sampling, background loop, generator lag
- [x] `adapters`: Valve (memory and Redis, every mechanism), p-limit, p-queue, Bottleneck (local and clustered), identity; registry with N/A matrix
- [x] `oracle`: rate (GCRA, fixed window, several rules), scoped, lease occupancy, client deadline with C1 classification, abort, lost jobs, competitor contracts; safety aggregate
- [x] `analyze`: outcomes, Kaplan-Meier, Aalen-Johansen, quantiles, metric families and bounds, fairness, t-intervals, permutation test, Holm, staged sequential decisions, A/A, MDE, verdicts
- [x] Golden statistics fixtures from scipy and lifelines, plus legacy-analyzer golden reproduction
- [x] `plan`: factors, seeded pairwise covering, risk cells, suites, profiles, budget estimator calibrated from measurements
- [x] `supervisor`: resource policy (ported v5), systemd scope and taskset isolation, authoritative flag, trial runner, resume and stale guard, retries, stop on safety failure, kill-on-timeout
- [x] `report`: JSON, CSV, Markdown and single-file HTML; safety printed before performance; labelled bounds and censoring
- [x] Tiers: micro, model, smoke, matrix, libs, soak, chaos, c1, doctor, calibrate
- [x] CI: `perf-pr.yml` (quick plus smoke, path-filtered), `perf-nightly.yml` (budgeted, self-hosted label, hosted fallback limited to smoke), `perf-decision.yml` (manual)
- [x] Docs: README (usage), REPRODUCING, adapters README, C1 issue draft, IMPLEMENTATION status
- [x] Verification: unit tests, typecheck, lint, quick tier, smoke on real Redis 7.4 and Valkey 8, short matrix sample, short soak and chaos samples, libs sample, report rendering

## 13. Integration decisions and practical limits

- Builds are frozen into content-addressed `.perf/builds/artifacts/` snapshots before workers
  start. Every dist file is rechecked before a trial. Changes to harness source during a run
  invalidate the trial; resumption requires the original harness and plan hashes.
- Lua correctness instrumentation taps the exact `TIME` sample used by admission. Reading TIME
  before the script body produced false microsecond rate violations on Redis 6.2; its clock is
  not frozen like Redis 7.2+. The production file and admission logic remain unchanged.
- Memory correctness records the exact public `memoryStore({ clock })` sample used inside
  admission. A pre-call timestamp can differ by one millisecond and create a false violation.
- Callback end is recorded inside the job body, before limiter settlement and lease-release
  bookkeeping. Promise-resolution timestamps would manufacture concurrency overlap.
- Current snapshots include the lockfile and Lua source. Direct IP and loopback aliases share
  an endpoint lock, preventing concurrent local runs from flushing one another's traces.
- `api` adds actual `wrap`, `wrapFetch` with a local fake HTTP response, shared pause/resume,
  Retry-After feedback, queue capacity, and batch-1 scenarios. Competitors are N/A for these
  Valve API contracts. No HTTP service or third-party endpoint is contacted.
- Per trial, job and call streams each have a 64 MiB fleet budget. A recorder fails explicitly
  if queued disk writes exceed 4 MiB. Open schedules are capped at 250,000 arrivals fleet-wide.
  Saturation/recording failure is visible, never silently sampled. Completed promises are freed.
- Continuous soaks default to two offered jobs/second with one-second resource samples. They
  retain the same processes and quota state for the entire duration; they are leak/drift tests,
  not saturation load tests. High-rate stress should use bounded trials within these limits.
- Weighted, scoped and duration-dependent saturated bounds are withheld in runtime analysis
  when a valid exogenous demand sequence cannot be reconstructed. Their admission models and
  boundary tests still run; raw throughput is always available. Finite-client bounds are N/A.
- Zero-grant early-versus-race attribution is withheld without a verified client/server call
  correlation. It is not guessed from a retry hint or a single server timestamp.
- OLS memory slopes are diagnostic under their residual-independence assumption. Serially
  correlated GC/RSS samples can violate that assumption; slope intervals are not release gates.
- Full smoke includes positive-deadline exposure and stops on any regression. PR CI covers
  memory/Redis/Valkey smoke, real-store integration, and the verified C1 rejection command.
  Historical failures remain failures; there is no known-defect waiver.
- The nightly workflow is manual-only until its dedicated runner and CPU variables exist.
  Hosted smoke is the default manual choice; enabling cron requires provisioning the host first.
- All five tiers, CLI and runner controls are implemented. Long decision and soak durations are
  not implied by unit coverage. See IMPLEMENTATION.md for actual executed run IDs and limits.

### Stack and repository seams

The private package reuses the installed public Valve Store API, Redis eval adapter, and callback
bodies. Worker control IPC is bounded; raw data goes to files. Existing legacy scripts and their
large archived inputs remain intact. No production source or public dependency changes are made.

| Component              | Choice                                   | Evidence and tradeoff                                                                 |
| ---------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------- |
| T0                     | tinybench 6.2.2                          | Installed typed API; raw per-task latency/throughput, no adapter-median subtraction   |
| Generated state traces | fast-check 4.10.2                        | Seeded boundary and randomized traces; pure model plus exact shipped Lua              |
| Real stores            | ioredis 5.11.1, Docker CLI               | Existing repository client; labelled containers, direct IPs, guarded operations       |
| Statistics             | stdlib t quantile 0.2.3                  | SciPy golden values; independent replication and preregistered looks                  |
| Tests                  | Vitest 5.0.3                             | Unit and opt-in serial real-store configurations, compatible with Node 24+            |
| Network                | iproute2 tc/netem                        | Real variable egress delay in disposable containers; one-direction shaping documented |
| Competitors            | pinned p-limit, p-queue, Bottleneck      | Installed implementations inspected; categories and caveats in adapters/README.md     |
| Reports                | JSON, CSV, Markdown, standalone HTML/SVG | No reporting service dependency; raw values and safety status retained                |

HTTP load engines (k6, autocannon, Artillery) do not observe internal admission grants, lease
ownership or callback deadlines, so they are not substituted for the process driver. Testcontainers
and dockerode would add orchestration APIs without replacing the current ownership/sentinel
contract. Hyperfine can time CLI startup but cannot establish admission semantics. These remain
optional external tools, not necessary dependencies. The implemented stack favors existing
repository machinery and a small dev-only dependency surface.
