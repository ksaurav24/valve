# Scheduler wakeup optimization: initial production validation

Implementation issue: [#108](https://github.com/ksaurav24/valve/issues/108).
Related [#97](https://github.com/ksaurav24/valve/issues/97) remains open: this
change does not solve the strict burst-1 thundering herd.

## Scope

- Rate denials on combined rate/global-lease valves use elapsed-call-compensated
  rate timing. Lease denials and custom stores without a denial cause retain
  conservative notification spreading and fallback polling.
- Asynchronous static policies whose rules all use banked GCRA can spread a
  denied retry uniformly by up to 25ms. Every rule's bank, the denied cost and
  queued deadlines bound that window; newly queued urgent jobs can preempt it.
  The bank keeps 2ms of transit/lateness reserve, rounded up to whole rate units,
  and deadlines keep 5ms of invocation slack. Strict burst-1, fixed-window,
  mixed fixed-window, synchronous and scoped paths receive no banked spread.
- Release notices received while a local release is pending coalesce with its
  completion wake. Completion invalidates older admission replies. Existing
  messages have no sender identity: a delayed echo after completion is processed
  normally. No counter assumes the next message is local, so a dropped echo
  cannot consume a later foreign wakeup.

Admission remains atomic and authoritative on the store clock. No Lua, store
protocol, public options, Redis keys, reservations, lookahead or handoff changed.

## Staged acceptance

The author approved small paired real-Redis samples before opening the PR.
**The comprehensive 32/64-worker matrix is a pre-merge blocker.** Complete banked
b10/b100/cron, combined and lease fairness cells, plus strict burst-1,
fixed-window, multi-rule, weighted, urgent deadline, cancellation, scoped,
Poisson, restart, stall and churn guards before merging. Investigate regressions
and attach the official evidence; do not widen statistical margins or oracles.

The earlier 20 October research is motivation, not measurement of this production
implementation. Its single-host results and 8-rep core/3-rep guard limitations
are recorded in issue #108. The safer release coalescing here is deliberately
narrower than the prototype's senderless echo counter.

## Environment and method

Measurements use Node 24.21.0, pnpm 11.28.4, Redis 7.4 and an Intel i5-12450H
Linux laptop. Only explicitly owned `valve-perf-redis74` and
`valve-perf-valkey8` containers were used; pre-existing unrelated containers and
processes were untouched. The initial resource guard required the unchanged
3GiB starting and 1.5GiB running headroom, swap/PSI and background-load limits.
It passed with 7.15GiB available. Workers use CPUs 2/4 and the server CPU 6,
inside the harness's normal no-swap, bounded-memory scope.

Baseline is master `fc76de6b9e11cc41871c312a24b24ffc2922e172` (merged PR #104).
The candidate is a content-hashed snapshot of the implementation working tree;
both source and distribution hashes are retained in each manifest. The baseline
and A/A arms use the same baseline artifact. Workload seeds are paired (root
seed `20261020`); scheduling randomness remains the production `Math.random()`.
Each cell uses five fixed repetitions, 1s warmup, 4s measurement and 1.5s drain.
Arm order rotates and cell order is seeded. The existing A/A validity rules,
paired intervals, metrics and fatal safety checks are unchanged.

All cells explicitly override the fleet to **four workers**. Historical cell
identifiers still contain `32w` or `16w`; their manifests' `workers: 4` is the
actual configuration. These samples cannot establish the full fleet result or
multi-host/WAN behavior. Uninstrumented performance rows retain `UNVERIFIED`
rate safety; separate instrumented candidate audit trials establish only their
own checked invariants and are excluded from timing comparisons.

## Reproduction

From the repository root, on Node 24, without competing builds/tests:

```sh
pnpm install --frozen-lockfile
pnpm perf infra up redis74 --cpuset 6
pnpm perf plan --profile targeted --suite gcra --cell sat-32w-500-b1 \
  --workers 4 --stores redis74 --base fc76de6 --current --reps 5 \
  --seed 20261020 --isolate --require-authoritative --worker-cpus 2,4
pnpm perf matrix --profile targeted --suite gcra --cell sat-32w-500-b1 \
  --workers 4 --stores redis74 --base fc76de6 --current --reps 5 \
  --seed 20261020 --isolate --require-authoritative --worker-cpus 2,4 \
  --run-id scheduler-wakeups-4w-gcra-20261021
pnpm perf matrix --profile targeted --suite combined --cell sat-16w-500-c8 \
  --workers 4 --stores redis74 --base fc76de6 --current --reps 5 \
  --seed 20261020 --isolate --require-authoritative --worker-cpus 2,4 \
  --run-id scheduler-wakeups-4w-combined-20261021
```

The GCRA substring intentionally selects burst 1, 10 and 100. Keep the complete
`.perf/runs/<run-id>/` directories (manifests, rows, calls, jobs and audit logs).
Use a new run ID when reproducing. Do not overwrite or pool historical runs.

## Initial measured samples

**All four cell-level A/A controls were UNSTABLE. Every formal candidate
comparison is INCONCLUSIVE.** The following are observed means, not validated
improvement or noninferiority claims. Parenthesized intervals are supplementary,
unadjusted paired 95% intervals on **head minus baseline**, computed over the
five independent repetition differences. They do not replace the harness's
family-adjusted intervals or override its A/A gates. The unchanged formal
intervals use `alphaLook = 0.003333…` for GCRA and `0.007142…` for combined.

| Actual four-worker cell | Calls/grant                               | Redis commands/s  | Redis CPU µs/grant                         |
| ----------------------- | ----------------------------------------- | ----------------- | ------------------------------------------ |
| Strict burst 1          | 4.108 → 4.092 (Δ -0.016 [-0.037, 0.006])  | 9049.0 → 9102.6   | 127.40 → 119.84 (Δ -7.56 [-34.84, 19.72])  |
| Banked burst 10         | 3.995 → 0.774 (Δ -3.222 [-3.283, -3.160]) | 10528.6 → 2227.6  | 110.16 → 60.30 (Δ -49.86 [-54.82, -44.91]) |
| Banked burst 100        | 3.813 → 0.516 (Δ -3.297 [-3.383, -3.211]) | 10498.3 → 1572.4  | 106.74 → 44.38 (Δ -62.37 [-75.86, -48.88]) |
| Rate + global lease     | 3.991 → 4.624 (Δ 0.633 [0.578, 0.688])    | 12269.9 → 18403.4 | 190.15 → 181.85 (Δ -8.30 [-12.03, -4.58])  |

| Actual four-worker cell | Useful starts/s                          | Nominal quota utilization | Mean per-trial backlog p99 (ms)            | Jain fairness                                 |
| ----------------------- | ---------------------------------------- | ------------------------- | ------------------------------------------ | --------------------------------------------- |
| Strict burst 1          | 420.15 → 424.15 (Δ 4.00 [-9.48, 17.48])  | 84.03 → 84.83%            | 1502.5 → 1604.8 (Δ 102.3 [-119.2, 323.8])  | 0.9952 → 0.9945 (Δ -0.0007 [-0.0030, 0.0016]) |
| Banked burst 10         | 502.10 → 502.00 (Δ -0.10 [-0.27, 0.07])  | 100.42 → 100.40%          | 1216.0 → 1217.0 (Δ 0.9 [-66.5, 68.4])      | 0.9973 → 0.9978 (Δ 0.0005 [-0.0049, 0.0058])  |
| Banked burst 100        | 524.50 → 524.30 (Δ -0.20 [-0.54, 0.14])  | 104.90 → 104.86%          | 1248.9 → 1293.7 (Δ 44.8 [-50.8, 140.4])    | 0.9963 → 0.9977 (Δ 0.0014 [-0.0026, 0.0054])  |
| Rate + global lease     | 299.90 → 394.45 (Δ 94.55 [90.75, 98.35]) | 59.98 → 78.89%            | 1165.2 → 896.4 (Δ -268.8 [-377.6, -160.0]) | 0.9944 → 0.9932 (Δ -0.0012 [-0.0039, 0.0014]) |

Banked measurement begins with an empty measured quota, separate from warmup,
so the initial burst bank can produce finite-window nominal utilization above
100%. The separate rate audits passed. Deadline success is **N/A** in these
backlog performance cells; they contain no deadline cohort. The strict control's
p99 interval is wide and does not establish latency noninferiority.

The A/A precision failures are concentrated in CPU metrics; strict burst-1 also
fails utilization precision, burst 100 calls precision, and combined also Jain
and useful-start precision. No margins were changed and no reruns were selected
to force equivalence. Longer windows/more fixed repetitions must resolve these
limits in the pre-merge study.

### Combined acquisition-cost finding

The combined sample shows **15.9% more acquisitions/grant** and **50.0% more
Redis commands/s**, alongside **31.5% more useful starts/s** and an observed
4.4% lower Redis CPU/grant. Total Redis CPU rises from 0.0570 to 0.0717
cores (+25.8%). This is not a uniform Redis-efficiency win. Retained
traces attribute the extra empty attempts/grant as follows:

| Denial cause                   | Baseline |   Head |
| ------------------------------ | -------: | -----: |
| Rate, zero grant per grant     |   2.9892 | 3.5867 |
| Lease, zero grant per grant    |   0.0020 | 0.0374 |
| Requested jobs per acquisition |   7.3835 | 7.1555 |

About 94.4% of the increased empty attempts/grant are rate denials. Banked
spreading is disabled in this strict combined cell; the cause-aware rate path
removes legacy lease jitter and subtracts elapsed call time. More frequent rate
retries are a plausible explanation for both the utilization gain and retry
cost; the data does not isolate A from E causally. Requests did not grow larger.
**Resolve this cost increase, or obtain explicit acceptance of the measured
tradeoff, before merging.** The official matrix must test whether it persists
at larger fleets. Do not describe this sample as regression-free.

### Evidence and safety disposition

[Machine-readable samples](./SCHEDULER-WAKEUPS.samples.json) retain baseline/A-A/
head repetition values, supplementary intervals, unchanged formal comparisons,
source/dist/diff identities, resource ranges and combined call diagnostics.
Local full archives:

- `.perf/runs/scheduler-wakeups-4w-gcra-20261021/`
- `.perf/runs/scheduler-wakeups-4w-combined-20261021/`

Both share fingerprint `8be0c1e33e9dc34f`. Baseline source hash:
`88640fcaf739b7ea66e0f042ef02cd779ec530c0a5b21a14d03b493a1a4d557d`;
candidate source hash:
`57c6ff9b1ad7267c99b9b24968379350ec1aca31197e607336a5919a7f73d064`.
There are **64 valid trials** (60 performance, four candidate audits), two
retained resource-invalid attempts rejected for host swap-in and successfully
retried by the existing harness, zero execution failures and zero safety flags.
All four candidate audits are PASS. Overall run safety remains UNVERIFIED
because uninstrumented performance arms cannot prove rate invariants. Separate
passing audits do not upgrade those rows.

## Correctness and packaging

- `pnpm check`: 426 unit/property tests, three type tests, lint, workspace
  typechecks/builds, conventions, package checks and footprint checks passed.
- `pnpm --filter @valve/perf test`: 221 passed; one archive-dependent test skipped.
- `REDIS_URL=... pnpm test:integration`: 78 passed on each of Redis 7.4 and
  Valkey 8; ten cluster/local-server-binary tests skipped per endpoint because
  those prerequisites were not provided.
- `PERF_INTEGRATION=1 pnpm --filter @valve/perf test:integration`: 50 passed,
  including owned-container fault/restart checks.
- `pnpm perf c1 --stores memory,redis74,valkey8`: all three deadline probes
  passed, rejecting expired callbacks without invocation.
- Website sync, 22 website tests and `pnpm docs:build` passed. Exported homepage,
  `/changelog` and `/releases` show 0.5.2, 0.5.1, 0.5.0 in newest-first order.

The author explicitly approved increasing the **packaging** core gzip ceiling
from 12,750 to 13,000 bytes: master uses 12,749, the implementation 12,970
(+221 bytes, 1.73%). Redis (6,300) and headers (2,048) ceilings, benchmark
statistical margins and all correctness oracles remain unchanged. The excessive
size regression uses `SIZE_BUDGETS.core + 1` and still rejects oversized inputs.

## Independent review

Fresh-context GPT-6.1 Sol HIGH adversarial review returned code correctness
**PASS**, no critical findings after remediation. The first review identified a
release/admission race: a suppressed notice could let an old in-flight denial
fall back to a 1s poll after capacity was freed. Local completion now increments
the admission epoch before checking the prior denial cause. Deterministic tests
cover static, previous-rate-wait and scoped variants. Independent read-only
arithmetic also reproduced the reported metric arrays,
paired intervals and combined call diagnostics. `rateRetryHintMs` averages
all rate-denied replies, including partial grants. The reviewer ran no
benchmarks; performance acceptance is separate and the full matrix remains
unverified until the pre-merge work is complete.
