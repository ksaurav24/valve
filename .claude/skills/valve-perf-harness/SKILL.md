---
name: valve-perf-harness
description: 'Run and interpret the private packages/perf harness in the valve repository. Use for portable baselines, size budgets, real-store safety checks, branch comparisons, or performance claims about valve internals.'
license: Apache-2.0
metadata:
  internal: true
---

# valve performance harness

`packages/perf` (`@valve/perf`) is a private laboratory. It builds frozen valve
artifacts (base and candidate), drives them only through public interfaces,
and reports **safety** and **performance** as separate conclusions. Benchmark
code and dependencies belong here, never in `packages/valve`.

Two principles shape every decision below:

- **Safety is not a performance metric.** A rate or lease violation, a lost
  job, or a callback that starts after its `maxWait` is a FAIL regardless of
  timings. `UNVERIFIED` means not established, never "pass".
- **Only like-for-like comparisons count.** Results are comparable only within
  the same environment fingerprint, build identities, plan, margins, and seed.
  Portable runs (laptops, hosted CI) are descriptive; performance decisions need
  an authoritative, isolated host.

All commands run from the repository root with Node 24 and pnpm 11.28.4.
Measurement runs write an immutable directory under `.perf/runs/<runId>/` (manifest,
hashes, raw records, report).

## Pick the tier for the question

| Question                                                | Command(s)                                                             | Needs                               | Time         |
| ------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------- | ------------ |
| Is my environment usable? What can it prove?            | `pnpm perf doctor`                                                     | nothing                             | seconds      |
| Did I break models or obvious hot-path costs?           | `pnpm perf quick` (model + quick micro)                                | nothing                             | minutes      |
| Did bundle size grow past budget?                       | `pnpm perf footprint --check` (also `pnpm check:size`)                 | nothing                             | < 1 min      |
| How much did size or cold import change vs master?      | `pnpm perf footprint --base master`, `pnpm perf startup --base master` | nothing                             | minutes      |
| Micro cost of one area (headers, group)?                | `pnpm perf micro --filter headers`                                     | nothing                             | minutes      |
| Do real Redis/Valkey keep every invariant?              | `pnpm perf smoke --stores redis74,valkey8`                             | Docker (harness-owned stores)       | 5 to 20 min  |
| Scoped admission cost by batch, rules, identities?      | `pnpm perf scoped --stores memory,redis74 --base master`               | Docker for Redis                    | minutes      |
| Pacing drift, queue wait, event-loop delay vs master?   | `pnpm perf drift --base master --response-ms 5`                        | nothing                             | minutes      |
| Is the candidate faster/slower than base (decision)?    | `pnpm perf plan ...` then `pnpm perf matrix ...`                       | authoritative host for a verdict    | 20 min+      |
| Laptop A/B on the calibrated Sylvie machine             | `pnpm perf plan --profile sylvie`, `pnpm perf:sylvie`                  | quiet Linux laptop, cgroups, Docker | about 21 min |
| How does valve compare to Bottleneck, p-limit, p-queue? | `pnpm perf libs --category L1,L2,...`                                  | Docker for D1-D3                    | varies       |
| Leaks over hours, behavior under faults                 | `pnpm perf soak`, `pnpm perf chaos`                                    | controlled infra                    | hours        |
| maxWait deadline regression (issue C1)                  | `pnpm perf c1 --stores memory,redis74,valkey8`                         | Docker for Redis/Valkey             | minutes      |

Default for a typical library PR touching the hot path: `doctor`, `quick`,
`footprint --check`, then `smoke` on Redis 7.4 and Valkey 8 if admission, Lua,
leases, or deadlines changed. Escalate to `matrix` only when a performance
claim or decision depends on it.

## First run

```sh
pnpm install --frozen-lockfile
pnpm --filter valvejs build
pnpm perf doctor
pnpm perf quick
pnpm perf footprint --check
```

`doctor` records whether this host can produce authoritative runs (Linux,
delegated cgroup v2 CPU and memory, swap off for the scope, `taskset`, pinned
containers). Missing controls make runs portable (`authoritative: false`), not
failed.

## Real stores: always harness-owned

```sh
pnpm perf infra up redis74      # also: redis62, redis8, valkey72, valkey8
pnpm perf infra up valkey8
pnpm perf infra status
pnpm perf smoke --stores redis74,valkey8
pnpm perf infra down redis74
pnpm perf infra down valkey8
```

The harness never runs `FLUSHALL`, and runs `FLUSHDB` only on a server recorded
in `.perf/infra.json` whose live sentinel matches its random token. Other URLs
use a unique key prefix and clean only that prefix. To reuse an existing empty
dedicated endpoint: `pnpm perf infra adopt <url> --empty-only` (refuses
non-empty databases). **Never** point the harness at production, shared
development, or any Redis with data you care about. Faults (`chaos`) require a
sentinel-verified disposable endpoint.

## Comparisons (matrix)

1. Plan first; it prints cells, arms, and an estimate without building or
   running anything:

   ```sh
   pnpm perf plan --profile targeted --suite gcra
   ```

2. Run paired base / A-A / head trials on immutable builds:

   ```sh
   pnpm perf matrix --profile targeted --suite gcra --base master --current
   ```

   `--current` measures the working tree; `--head <ref>` measures a commit.
   Estimates over 60 minutes need `--yes`. `--dry-run` previews.

Profiles: `smoke` (1 rep, correctness, no verdicts), `targeted` (risk cells,
5 reps), `sylvie` (laptop preset, 10 pairs), `nightly` (budgeted, 5 reps),
`decision` (staged 5/10/20 reps, Bonferroni). Suites: `gcra`, `fixed-window`,
`multi-rule`, `scoped`, `weighted`, `lease`, `combined`, `deadlines`, `stores`,
`lifecycle`, `faults`, `runtime`, `network`, `api`.

A short wiring sample (descriptive only, labelled as a sample):

```sh
pnpm perf matrix --base HEAD --current --suite gcra --cell sat-1w-100-b1 --reps 1 --window 1s --warmup-ms 0 --drain-ms 100 --html
```

For authoritative evidence: pin server and workers to separate physical cores
(`pnpm perf infra up redis74 --cpuset <cpus>`, `--worker-cpus <cpus> --isolate --require-authoritative`),
no competing workloads (no builds or tests running), and preregistered reps and
windows. Details: [references/reading-results.md](references/reading-results.md).

## Reading results

Read **safety first**, then performance:

1. Safety: `PASS`, `FAIL`, `UNVERIFIED`. Any FAIL is a correctness bug to fix,
   regardless of speed. UNVERIFIED means missing instrumentation; don't report
   it as passing.
2. Performance per metric and cell: `REGRESSION`, `IMPROVEMENT`,
   `NONINFERIOR`, `EQUIVALENT`, `INCONCLUSIVE`, `UNSTABLE`, `DESCRIPTIVE`.
   `UNSTABLE` means the A/A control failed, so the A/B result is downgraded to
   `INCONCLUSIVE`. `DESCRIPTIVE` means fewer than five replications.

Never widen margins, drop valid trials, or rerun until a verdict appears. If
A/A is unstable, preregister longer windows or more reps in a new run.
`pnpm perf report <runId> --html` re-renders a run.

## Exit codes

`0` completed, `1` safety/regression/execution failure, `2` invalid arguments or
setup. `c1`: `0` verified rejection, `1` late callback, `2` inconclusive.

## Reporting in a PR

Quote: run id, commit, whether the run was authoritative, the command, safety
status, and per-metric verdicts. Say "descriptive" or "portable" when that is
what you have. The main matrix workloads use immutable policies, so they do
not establish managed-limit overhead. `src/measure/managed.ts` is a separate
local admission diagnostic; it does not establish runtime-update propagation
or fleet performance. Add dedicated workloads before making those claims.

## Changing the harness itself

- Tests: `pnpm --filter @valve/perf test` (builds valvejs first),
  `pnpm --filter @valve/perf typecheck`, and
  `PERF_INTEGRATION=1 pnpm --filter @valve/perf test:integration` for real stores.
- Size budgets live in the footprint tier; raising one is a deliberate,
  documented decision in `packages/perf/README.md`, not a fix for a failing
  check.
- Binding design and statistics: `packages/perf/RFC.md`. Reproduction:
  `packages/perf/REPRODUCING.md`. Ownership and CI map: `packages/perf/docs/OWNERSHIP.md`.

For the full command list see [references/commands.md](references/commands.md).
