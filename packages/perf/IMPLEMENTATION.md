# Performance harness implementation record

Updated on 2026-10-19 after merging `origin/master` into `feat/perf-harness`.
Node 24.21.0, pnpm 11.28.4, valvejs 0.5.2.

Local checkpoint `65c0e78` preserves the original complete harness. Merge `a6d14fe` brings in
master through `161ea0d`, including the C1 fix and the 0.5.2 release. The only merge conflict
was `.gitignore`; both sets of benchmark exclusions were retained. This work adds no further
production source changes, release, issue, or pull request.

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

- Local timings are non-authoritative: controlled resource scopes and CPU pinning were not used.
  Do not pool runs across fingerprints or harness/build identities.
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
