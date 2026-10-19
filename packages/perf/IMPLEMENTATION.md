# Performance harness implementation record

Updated on 2026-10-19 after merging `origin/master` into `feat/perf-harness`.
Node 24.21.0, pnpm 11.28.4, valvejs 0.5.2.

Local checkpoint `65c0e78` preserves the original complete harness. Merge `a6d14fe` brings in
master through `161ea0d`, including the C1 fix and the 0.5.2 release. The only merge conflict
was `.gitignore`; both sets of benchmark exclusions were retained. The harness adds no further
production source changes or package release.

## Updated behavior

- C1 is now a regression check. PASS requires the blocking job to finish, its stall to cross
  the next deadline, and the next job to reject with `MAX_WAIT_EXCEEDED` without starting.
- C1 exits 0 for verified rejection, 1 for a late callback, and 2 for incomplete evidence or
  unrelated rejection. Raw results include the rejection code and proof conditions.
- Every real-time deadline violation now stops execution. Historical pre-fix failures remain
  failures, including when their reports are regenerated.
- PR CI covers real-store integration, the C1 command, and memory/Redis/Valkey smoke.
- The nightly workflow is manual-only, defaulting to hosted smoke. Enable its schedule only
  after provisioning the `valve-perf` runner and disjoint server/worker CPU variables.

## CodeRabbit review follow-up

Addressed all ten inline findings and four additional review suggestions on PR #104.

- Manifest, revision-cache, and infra-registry writes now publish atomically.
  Cached artifact verification reuses its recorded git SHA, including when
  `VALVE_PERF_HOME` is outside Git. A completion marker containing the full ref SHA
  and patch digest is written only after checkout and patch application succeed.
  Unproven worktrees and old unproven caches are prepared again; a failed patch
  retry never builds or labels the unpatched base as a candidate.
- Endpoint locks publish complete owner records and reclaim only confirmed dead
  PIDs. Recovery is serialized, and release checks ownership. Live, inaccessible,
  malformed, or interrupted-recovery owners fail closed. Sylvie uses the same
  recovery path. The real-store smoke run recovered an injected stale PID lock.
- Store provisioning removes only containers bearing the unique creation token
  of the failed attempt. Readiness and sentinel failures roll back before registry
  publication, while reused containers remain intact. Adapter shutdown attempts
  Valve and Store cleanup independently even when either close throws or rejects.
- Server CPU accounting recognizes systemd and cgroupfs Docker layouts. Missing
  or partial accounting is unknown, not zero; background CPU is withheld when it
  cannot be calculated. Authoritative resource qualification fails closed for
  unavailable CPU counters. Memory-only trials retain a known zero server cost.
- Normal smoke execution skips unregistered stores; dry plans, Sylvie provisioning,
  and explicit endpoint overrides retain catalog-based planning. The standalone
  perf test command builds Valve before Vitest. Legacy archive locations are
  explicit, and archive-dependent tests use `VALVE_EVIDENCE_ARCHIVE`.
- Zipf draws reuse a bounded cumulative-weight cache and binary search. Seeded
  regression checks compare 18,000 draws with the former sampler. Floating-point
  threshold boundaries can differ; historical harness identities remain separate.
- Current website size ceilings match the unchanged perf budgets. The repository
  actionlint config declares `valve-perf`. Function contracts were expanded to
  address the documentation warning, and dedicated-runner trust/local-lock limits
  are explicit in the reproduction guide.

Validation passed on Node 24.21.0: `pnpm check`, all 184 perf tests, 48 real-store
integration tests, 21 release/CI script tests, 22 website tests, and 32 browser
checks. The measurement tests also passed after moving the existing Valve dist
out of the way, verifying the standalone test prerequisite. Actionlint passed
without a temporary custom config. The legacy replay regenerated identical fixture
values, and missing archive configuration fails before extraction.

`coderabbit-unprovisioned-node24` selected its memory GCRA cell and explicitly skipped
three unavailable store cells. `coderabbit-final-smoke-node24` passed all 34 cells, including
actual stale-lock recovery. `c1-1792406038645-f6f4f34c` passed all three store checks. The quick
tier completed 77 model/oracle checks and 13 micro tasks.

These command manifests record harness SHA-256 `ba95feac35b0670d3979747efda0e71e5cab5089ee2dd37e1b8dd431ff44d762`.
Both temporary stores were removed, all endpoint locks released, and all eight
pre-existing containers remained running. Review snapshots, command logs, and
external-cache proof are retained in `.perf/verify-coderabbit-20261019/`.
No performance margins were relaxed or historical performance verdicts upgraded.

## Complete benchmark ownership migration

All active benchmarks now belong to `packages/perf`, including size budgets,
bundle/source attribution, cold startup, public-store drift, and scoped admission.
The old library bench directory and six root benchmark scripts are removed. The
four reports moved to `docs/history/` with their original measurements and evidence
links retained. See [the coverage map](./docs/OWNERSHIP.md).

Valve's production source, exports, and runtime dependencies are unchanged. Its
benchmark-only development dependencies and size script were removed. A patch
changeset records that package metadata cleanup; no version was published.
The website changelog was synchronized, rebuilt, and checked at `/changelog`,
`/releases`, and the homepage. Published 0.5.2 remains visible, and the changelog
retains newest-first ordering.

`perf-pr.yml` now owns portable, real-store, and footprint checks on relevant PRs
and master pushes; `bench.yml` is retired. The deterministic size budgets are
unchanged. Hosted timing probes remain descriptive; the old 15% pooled-median
gate is replaced by the controlled-host harness decision protocol, not by a
hosted timing threshold. Nightly and decision execution remain manual.

Verification on Node 24.21.0 and pnpm 11.28.4:

- Full `pnpm check` passed: lint/format, workspace types, 389 production tests with
  coverage, type tests, all builds, source conventions, package validation, and size.
- Final perf typecheck and all 167 tests passed. Real-timer unit tests now run
  sequentially: one Bottleneck spacing assertion failed when the new cold-process
  probes ran concurrently. The existing 3 ms tolerance was not changed.
- All 48 Redis/Valkey integration tests, 21 CI/release script tests, 22 website
  tests, and 32 desktop/mobile browser checks passed. Actionlint 1.7.7 passed.
- `footprint-1792395600967-c4775117`: both artifacts' 16 footprint rows exactly match the
  pre-migration tool. Source sizes remain 12,749 / 6,235 / 1,263 gzip bytes against
  ceilings of 12,750 / 6,300 / 2,048.
- `startup-1792395604559-8ed31b00` retained 180 cold-process samples; `drift-1792395612691-22a4e049` retained
  six paired drift samples. Both measure master and current with one implementation.
- `model-1792395621920-739ca0d7` and `micro-1792395623591-869e0385` completed the quick tier: 77 model/oracle
  checks and 13 micro tasks, including the individual header readers.
- `scoped-1792395638310-6a3a3b1f` passed 162 scoped scenarios and 12 contention scenarios
  across both artifacts and memory/Redis 7.4/Valkey 8, at the original 100 iterations.
  Policies are immutable, matching `createValve`, without importing private helpers.
- `c1-1792395634531-8e4e7410` passed memory/Redis/Valkey deadline rejection. `perf-ownership-final-node24` completed
  all 34 selected smoke cells with safety PASS and exit 0.

These final command manifests record harness SHA-256
`9bc991b9431d29a01a993630ebd5fb6dcd074fe81bb45a01b0178d3f252bb394`. Run metadata is retained in `.perf/verify-ownership-20261019/`.
Both temporary stores were removed, and all eight pre-existing containers retain
their original running state. These diagnostics do not resolve the earlier Sylvie
A/A uncertainty or establish new performance improvements.

## Sylvie preset

The preset is named after Sylvie, the i5-12450H laptop used for calibration. It was originally
validated under the name `laptop`; the retained run IDs and source hashes below preserve that
historical identity. The rename changes the command, profile, and cell names, not the default
workloads, timing, replication count, resource limits, or statistical margins.

After closing other apps, available RAM increased from about 5.8 GiB to 8.2 GiB on the
i5-12450H laptop. `pnpm perf:sylvie` now supplies a focused paired plan: GCRA 500/s and global
leases, two workers, ten fixed repetitions, 15-second windows, two-second warmups, and one
correctness audit per cell. The calibrated estimate is 21.3 minutes for 62 trials.

On this topology, workers use logical CPUs 2/4 and Redis uses CPU 6, all on separate fast
physical cores. The preset requires isolation, limits the process scope to 3 GiB with no swap,
and uses a 2 GiB memory guard with 4 GiB starting / 2 GiB running host headroom. Margins and
A/A withholding remain unchanged. Provisioning and cleanup apply only to the owned store
created for the run; matching registered stores are preserved.

All 154 unit tests, harness typecheck, root lint/format, and source checks passed. New tests
cover hybrid-core placement, bounded planning, dry-run behavior, and failure cleanup without
removing reused stores. `laptop-probe-node24` completed four isolated sample trials, including
a passing correctness audit, and removed its temporary Redis store.

`laptop-validation-node24` then ran the complete default plan with identical `HEAD` builds:
62/62 trials completed successfully in 20.96 minutes, with zero resource rejections or retries.
Both instrumented correctness audits passed. Trial telemetry recorded peak scope memory
0.374 GiB, minimum available host memory 7.034 GiB, and maximum background CPU 0.451 cores.
The live kernel scope was separately verified with a 3 GiB cap and zero permitted swap.

Seven of nine A/A metric intervals are EQUIVALENT. Two remain UNSTABLE: rate utilization
(difference interval -1.788 to +2.689 percentage points against a ±1 point margin) and lease
Jain fairness (-0.03590 to +0.02686 against ±0.02). Both cell controls remain UNSTABLE and all
nine candidate comparisons remain INCONCLUSIVE. This is successful execution with unresolved
performance evidence, not proof of an optimization. The preset's focused workloads differ from
the earlier one-worker run and are not pooled with it.

Probe and full-run manifests record harness SHA-256
`b4dbf88068354ff0caec4cbac95ecf6f8bd3081a3a74dac85b757e33d5401155`.
Run metadata and live scope observations are also retained in `.perf/verify-laptop-20261019/`.
The automatically provisioned Redis container was removed after each run.

## PR preparation after the Sylvie rename

`pnpm check` passed again, including 389 production tests, type tests, all builds, package
validation, and size checks. The renamed harness passed all 154 unit tests and 48 Redis/Valkey
integration tests. C1 passed on memory, Redis 7.4, and Valkey 8
(`c1-1792393940129-b23882b6`). `pr-final-smoke-node24` completed all 34 selected
memory/Redis/Valkey smoke trials with safety PASS and exit 0.

`sylvie-rename-probe-node24` separately completed four isolated trials under the new command
and cell names, including a passing correctness audit and automatic store cleanup. Its one-rep
performance results remain descriptive. The earlier 62-trial study retains its original names,
source hash, and unresolved A/A findings; it was not relabelled as a new full run.

## Follow-up audit coverage

The follow-up fixes harness evidence gaps without changing production Valve or statistical
margins:

- Distributed Valve library cells now receive one separate `valve-audit` correctness arm.
  Audit timings never enter performance or A/A comparisons. Performance rows retain their
  own UNVERIFIED rate/window coverage; a separate audit cannot retroactively verify a run.
- Planned restart correctness trials atomically capture the Lua log and pause writes until
  the server restarts without persistence. Pre-reset snapshots survive outside the container;
  replay uses server-clock reset boundaries. Missing or expired checkpoints remain UNVERIFIED,
  and incomplete grant logs behind a claimed complete checkpoint fail reconciliation.
  This tests a planned restart with an audit barrier, not an unannounced crash.
- Single-worker plans exclude Jain fairness before execution, because the analyzer cannot
  estimate equal-share fairness with one worker. Missing applicable metrics still block A/A.

Validation: 150 unit tests, 48 real-store integration tests, harness typecheck, and ESLint passed.
Integration checks prove both pre-reset and post-reset events survive on Redis 7.4 and Valkey 8.
`audited-libs-node24` completed 12 trials over D1-D3; all three Valve correctness audits passed.
Its six uninstrumented rate/window rows remain UNVERIFIED. One-rep library comparisons remain
descriptive. `audited-restart-node24` passed its ten-second Valkey 8 restart trial, with measured
throughput recovery about 917 ms after fault completion.

`isolated-aa-node24` completed ten fixed pairs with ten-second windows, CPU 6 for Redis and
CPU 4 for workers, protected cgroup memory limits, and the original margins. Both refs point
to the same production artifact. All 31 planned trials completed; two additional attempts were
rejected for background CPU activity and successfully retried. The correctness audit passed.
Utilization, calls per grant, and Redis CPU A/A intervals are EQUIVALENT. Application CPU
remains UNSTABLE: its mean-difference interval is about -33.34 to +63.93 microseconds per start,
outside the resolved margin of ±35.62. Overall A/A remains UNSTABLE, so all four candidate
comparisons remain INCONCLUSIVE. More controlled, longer measurements are still needed.

These three follow-up manifests record harness source SHA-256
`a58032c2b487709668ff3da684c165afe49f6852d1d65cb1fb83b804ccbb3bec`.

Exact competitor rate/window semantics still need library-specific reservation traces. Callback
timing tolerances have not been widened, and historical results have not been rewritten.

## Post-merge verification

| Check                                | Result and retained evidence                                                                                                                                                                                                                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository check                     | `pnpm check` passed: lint/format, workspace typecheck, 389 production tests, three type tests, coverage thresholds, all builds, source conventions, package/exports, and size budgets. Runtime smoke additionally passed on Node 20, 22, and 24 for ESM, CommonJS, and subpath exports.                       |
| Website                              | 22 tests passed; 74 routes rebuilt. Changelog, releases, and homepage show 0.5.2, 0.5.1, 0.5.0 in newest-first order. Release maturity remains beta.                                                                                                                                                          |
| Harness unit                         | 147 tests in 19 files passed, including strict C1 proof conditions and historical report preservation.                                                                                                                                                                                                        |
| Harness integration                  | 46 tests in four files passed on Redis 7.4 and Valkey 8, including the new positive C1 rejection checks.                                                                                                                                                                                                      |
| Production integrations and examples | 385 passing executions across Redis 6.2/7.4/8 and Valkey 7.2/8: 85 combined Redis 7.4/cluster/recovery/subscriber checks plus 75 on each other store. Examples passed on all five stores. Ten fixture-specific cases are skipped on the other stores because they already ran in the combined suite.          |
| C1 controls                          | Old `1979020` build: FAIL with about 30 ms lateness. Fixed master: PASS with MAX_WAIT_EXCEEDED and no callback start. `c1-1792387387683-875cf969` separately passed memory, Redis 7.4, and Valkey 8 with exit 0.                                                                                              |
| Quick and calibration                | All nine micro tasks and 75 portable model/golden/oracle checks passed. Runs model-1792387046505-42fe9a81 and micro-1792387048235-65389116. Cold-process calibration completed at one/four workers.                                                                                                           |
| Full smoke                           | `merged-smoke-node24`: all 41 trials executed successfully and all 41 reported safety PASS, including the deadline cell that failed before the upstream fix. Exit 0.                                                                                                                                          |
| Library samples                      | `merged-libs-local-node24`: 26 local trials; `merged-libs-node24`: nine distributed trials. All 35 executed successfully over L1-L5 (including L1-noop) and D1-D3. Safety: 24 PASS, 11 UNVERIFIED, no violations. One-rep comparisons are descriptive; results from the separate fingerprints are not pooled. |
| Paired matrix                        | `merged-paired-node24`: 16 successful trials (five base/A-A/head reps plus audit). Audit safety PASS; uninstrumented rate arms UNVERIFIED. A/A unstable; four estimable A/B metrics INCONCLUSIVE. Single-worker Jain has no inferential sample.                                                               |
| Continuous soak and chaos            | `merged-soak-node24`: one continuous eight-second lease trial, safety PASS. `merged-chaos-node24`: all six two-second fault cells completed, five safety PASS and restart UNVERIFIED because pre-restart audit evidence was lost. All fault helpers recorded completion without errors.                       |
| Legacy and patch builds              | Legacy golden regeneration passed against the read-only archive. Current, master-ref, and comment-only patch builds passed; current production dist hash is 48e3876a8684352ebd063ca19018f9117df5b15cacabf874998394f52bc688e9.                                                                                 |
| CI                                   | Workflow syntax/arguments checked locally. GitHub Actions have not run for this branch. Automatic nightly execution is disabled until its host exists.                                                                                                                                                        |

All six real-time run manifests record harness source SHA-256
`23766ddca2b45baa130c20c961ae3b478783e614a65644f8878622007d37bcaa`.

Command logs, production-matrix results, C1 controls, website checks, and setup/cleanup records
live in `.perf/verify-merged-20261019/`. Run directories under `.perf/runs/` retain manifests,
raw compressed payloads, rows, and JSON/CSV/Markdown/HTML reports. Preserve complete directories.

## Interpretation and limits

- The post-merge samples in the table are non-authoritative: controlled resource scopes and CPU
  pinning were not used. Follow-up isolated studies record their controls separately. Do not pool
  runs across fingerprints or harness/build identities.
- One-rep library samples are descriptive. Short paired windows verify execution and statistical
  withholding, not release performance. Long decision/nightly profiles and hour-scale soaks were
  not run; no performance improvement or long-term leak conclusion is established.
- Competitor concurrency and queued cancellation are observable. Rate/window callback envelopes
  are diagnostics; exact third-party reservation clocks remain UNVERIFIED. Approximate Bottleneck
  L4 and identity floor rows remain raw-only. Nothing is subtracted from the floor.
- T1 models admission state, not JavaScript scheduling, timers, sockets, or promise ordering.
  Production cluster compatibility is tested separately from distributed performance claims.
- Runtime bounds and zero-grant race attribution remain withheld where the required exogenous
  demand or call correlation cannot be reconstructed. OLS memory slopes remain diagnostics.
- Job/call streams each have a 64 MiB fleet budget, queued disk writes are bounded, and schedules
  cap at 250,000 arrivals. Exceeding a limit fails explicitly rather than sampling silently.
- Redis Cluster performance, Sentinel, TLS, multi-host fleets, and more than 64 processes remain
  outside the performance harness's v1 scope.

All six owned store containers and the three verification-only cluster containers were removed.
All eight pre-existing containers remain present with their original running state. Evidence
archives, raw trial payloads, and build snapshots remain available.

## Historical evidence

Pre-merge verification against valvejs 0.5.0 is retained, not rewritten: `verified-final-smoke-node24`
completed 41 trials with 40 safety PASS and one FAIL (22 C1 late starts); the earlier five-rep
paired sample withheld conclusions after unstable A/A. `verified-libs-node24-v4` completed all
35 trials, and the earlier short soak/chaos samples retain their original statuses. These are
historical observations, not verification of the fixed build.

[Issue #100](https://github.com/ksaurav24/valve/issues/100) is fixed by
[PR #101](https://github.com/ksaurav24/valve/pull/101), included in 0.5.2. The C1 issue document
records the original defect and current regression contract.

The pre-harness archive remains read-only at
`/home/xlr8/valve-evidence-archive/2026-10-19-pre-harness/`, with its tar archive, 6,906-file hash
manifest, and archive-time git status. Master pruned tracked benchmark output; that archive and
new local evidence remain intact.

Start with [README.md](./README.md), use [REPRODUCING.md](./REPRODUCING.md) for commands, and
read [RFC.md](./RFC.md) for measurement and decision rules.
