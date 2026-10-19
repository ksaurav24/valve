# Performance harness implementation record

Verified locally on 2026-10-19 with Node 24.21.0 and pnpm 11.28.4.

The complete five-tier harness, CLI, competitor adapters, models/oracles, statistics, reports,
and three CI workflows are implemented. This record describes executed verification; it does
not establish an authoritative performance result. Production Valve source and its runtime
dependencies are unchanged. No release, pull request, or publication was created.
C1 was subsequently filed at the user’s request as [issue #100](https://github.com/ksaurav24/valve/issues/100).

## Integrated coverage

- T0 uses Tinybench for local operation costs; T1 checks admission models, parity, and bounds.
- T2 launches fresh worker processes against memory and guarded Redis/Valkey endpoints.
- T3 supports immutable current/ref/patch builds, paired trials, A/A, staged 5/10/20 decisions,
  and category-matched competitor comparisons with pinned versions and explicit N/A pairs.
- T4 keeps continuous state for low-load soaks and injects server/worker faults on owned infra.
- JSON, CSV, Markdown, and standalone HTML retain raw absolutes, independent safety status,
  missing/censored outcomes, A/A instability, and non-authoritative-run notices.
- Manifests hash the harness, builds, lockfile, Lua, environment, cells, seeds, endpoints, runtime
  policy, and statistical plan. Resume rejects incompatible evidence. Dist snapshots are frozen
  before execution, and source changes during a trial invalidate it.
- Recording and arrival limits fail explicitly. Endpoint locks prevent concurrent local runs
  from flushing the same server through direct-IP and loopback aliases.

## Verification results

| Check                      | Evidence and result                                                                                                                                                                                                                                         |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Portable unit suite        | 145 tests in 19 files passed on Node 24; includes model/boundary, statistics golden, censoring, reports, CLI, safety, library analysis, and the C1 reproducer.                                                                                              |
| Real-store integration     | 44 tests in four files passed on Redis 7.4 and Valkey 8, including real processes, first-call Lua logging, public API feedback, and warmed identity/p-queue/distributed Bottleneck backlogs.                                                                |
| Quick tier                 | Model/parity/golden/oracle checks passed; all nine Tinybench tasks completed. Runs `model-1792384571287-9103fd4c` and `micro-1792384573226-9972a2b3`.                                                                                                       |
| Full smoke                 | `verified-final-smoke-node24`: all 41 trials executed; 40 safety PASS, one safety FAIL with 22 C1 late starts. Expected exit 1; no production safety claim.                                                                                                 |
| Paired matrix sample       | `verified-final-paired-node24`: 16 successful trials, five base/A-A/head reps plus audit. Audit safety PASS; uninstrumented rate arms UNVERIFIED. A/A unstable; four estimable A/B metrics INCONCLUSIVE. Single-worker Jain has no inferential sample.      |
| Competitor sample          | `verified-libs-node24-v4`: all 35 trials over 26 supported cells and nine categories completed. Safety: 24 PASS, 11 UNVERIFIED, no violations. All 69 comparison entries DESCRIPTIVE at one rep; floor/approximate mappings remain raw-only.                |
| Continuous soak sample     | `verified-soak-node24`: one continuous eight-second Valkey 8 lease trial, safety PASS, seven worker and eight server resource samples. Drift metrics are diagnostic only.                                                                                   |
| Chaos sample               | `verified-chaos-node24`: six two-second Valkey 8 fault cells completed. Five safety PASS; restart UNVERIFIED because the server lost its pre-restart audit log. All faults recorded their effect/completion; CPU/load helpers recorded expected exit codes. |
| Standalone C1              | `c1-1792384491360-e5624fdc`: memory and Valkey 8; `c1-1792384735891-1275b1fa`: Redis 7.4. All reproduced about 30–31 ms late, persisted safety FAIL, and exited 1.                                                                                          |
| Build identities           | Current, isolated HEAD-ref, and comment-only patch builds completed with identical production dist SHA-256 `8347f92e03f68d000f164e4d6fb0651467ff3cd54c71d382f7bc61022c3e5c93`.                                                                              |
| Repository checks          | Workspace typecheck, lint/format, source conventions, production 366 tests, three type tests, package/exports/size checks passed.                                                                                                                           |
| Website                    | 22 tests and `pnpm docs:build` passed; 74 routes built, including changelog, releases, and homepage. No changeset or release metadata changed.                                                                                                              |
| Legacy golden regeneration | The archived analyzer ran over all 17 confirm cells and regenerated the three-cell fixtures; portable golden tests passed afterward.                                                                                                                        |
| CI                         | Workflow YAML formats and public CLI arguments checked locally. GitHub Actions jobs have not been executed.                                                                                                                                                 |

Smoke exercised Redis 6.2/7.4/8 and Valkey 7.2/8, a built netem image with 5 ± 2 ms delay,
memory, wrapped public APIs, shared feedback, weighted/scoped rules, leases, lifecycle churn,
worker crash/join, client disconnection, event-loop blocking, and deadline exposure. Retained
platform/mechanism runs include `verify-mechanisms-v3` and `verify-platform-v2`.

Final smoke and unit/integration checks include the last CLI correction. Library/soak/chaos runs
include the final backlog/comparator and clock-tap changes and precede only the CLI relative-patch-path
correction. Every manifest retains its own harness hash; evidence from different implementations
is not pooled. Earlier full smoke (`verified-full-smoke-node24`), paired samples, and failed
exploratory runs are also retained.

## Statistical and measurement limits

- Every local timing run is non-authoritative: server/worker CPU pinning and controlled resource
  scopes were not used. Fingerprints differ with the selected server set; never pool those runs.
- One-rep runs are descriptive. Explicitly shortened windows do not satisfy normal eligibility
  requirements. The paired sample validates execution and A/A withholding, not a release decision.
- Competitor callback concurrency and queued cancellation are observable. Rate/window callback
  envelopes are diagnostics; exact third-party reservation clocks remain UNVERIFIED. Bottleneck
  L4 is approximate and raw-only. Identity is an unconstrained floor, never subtracted.
- L1/L1-noop use uniform 100 ms windows to keep raw recording bounded. This is a local overhead
  diagnostic, not a distributed performance claim. Backlog refill yields uniformly for all
  adapters, including synchronous identity callbacks.
- T1 models admission state, not JavaScript scheduler, timer, socket, or promise behavior.
- Runtime bounds are withheld where valid exogenous weighted/scoped/duration demand cannot be
  reconstructed. Zero-grant early/race attribution is withheld without call correlation.
- OLS memory trends assume independent residuals. GC/RSS samples may be correlated; these
  slopes are diagnostics, not leak-proof or release gates.
- Long decision/nightly profiles, hour-scale soaks, authoritative cgroup/pinning execution,
  remote CI runs, and every possible factor combination were not run locally.
- Redis Cluster, Sentinel, TLS, multi-host fleets, and more than 64 processes remain outside v1.
- C1 is deliberately exposed as an absolute safety failure. Its focused unit test passes when
  it reproduces the production defect; the standalone reproducer and full smoke exit 1.

## Evidence retention

Verification containers were removed through the guarded CLI. All eight unrelated containers
were checked afterward and preserved. Local run/build evidence remains available.

Local runs live under `.perf/runs/<runId>/` and are ignored by git. Preserve the entire run
directory, including its manifest, rows, raw compressed payloads, and reports. PR/hosted-smoke
artifacts retain runs for 14 days, nightly artifacts for 30 days, and decision artifacts for
90 days. Workflow upload and cleanup steps use `always()`.

Pre-harness evidence remains read-only at
`/home/xlr8/valve-evidence-archive/2026-10-19-pre-harness/`, with its tar archive, 6,906-file
hash manifest, and archive-time git status. Legacy raw evidence is not deleted or rewritten.

Start with [README.md](./README.md), use [REPRODUCING.md](./REPRODUCING.md) for exact commands,
and read [RFC.md](./RFC.md) for the measurement and decision rules.
