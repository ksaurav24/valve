# Valve performance harness

`@valve/perf` is the private correctness and performance laboratory for Valve. It is not part of
the `valvejs` runtime, is not published, and exercises built Valve artifacts only through public
interfaces. The binding design and statistical rules live in [RFC.md](./RFC.md).

The current workloads use immutable policies. Historical latency and throughput
results do not establish the overhead of `limits: 'managed'`, runtime updates,
subscriber wakeups, polling rechecks, or scoped lazy migration. Add dedicated
workloads before making managed-limit performance claims.

## Start here

Use Node 24 and pnpm 11.28.4 from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter valvejs build
pnpm perf doctor
pnpm perf quick
```

`quick` is portable and does not use Docker. For the real-store smoke profile, create dedicated
harness-owned stores first:

```sh
pnpm perf infra up redis74
pnpm perf infra up valkey8
pnpm perf smoke --stores redis74,valkey8
pnpm perf infra down redis74
pnpm perf infra down valkey8
```

All active benchmark code, dependencies, size budgets, and probes live in this package.
See [OWNERSHIP.md](./docs/OWNERSHIP.md) for the migration and CI coverage map.

See [REPRODUCING.md](./REPRODUCING.md) for comparisons, run archives, and exact reproduction.
[IMPLEMENTATION.md](./IMPLEMENTATION.md) records executed checks, retained run IDs, and limits.

## Sylvie laptop comparison

The `sylvie` preset is named after Sylvie, the laptop used to calibrate and validate it:
an Intel i5-12450H with 16 GB RAM.

For a quiet Linux laptop with at least three comparable physical cores and 4 GiB available RAM:

```sh
pnpm perf plan --profile sylvie
pnpm perf:sylvie
```

The preset compares `HEAD` against the current checkout using two workers, GCRA at 500/s,
and a global-lease workload. Each cell gets ten base/A-A/head repetitions, 15-second windows,
two seconds of warmup, and a separate correctness audit. The calibrated estimate on an
i5-12450H is about 21 minutes. `--suite gcra` selects just the rate case for a shorter run.

It pins workers and the server to separate fast physical cores, requires isolation,
caps the process scope at 3 GiB with swap disabled, and provisions a disposable Redis 7.4
container if needed. It removes only the store it created. Existing mismatched stores are
refused, not recreated. Original margins and A/A gates remain in force; completion does not
guarantee a resolved performance result. See [REPRODUCING.md](./REPRODUCING.md).

## Five evidence tiers

| Tier          | Commands                                         | Claims and limitations                                                                                                                                  |
| ------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T0 micro      | `pnpm perf micro`                                | In-process operation costs. It says nothing about distributed behavior or Lua correctness.                                                              |
| T1 model      | `pnpm perf model`                                | A pure admission-state model, parity checks, capacity bounds, and abstract-client simulation. It is not a virtual-time simulation of Valve's scheduler. |
| T2 smoke      | `pnpm perf smoke`                                | Short real-time memory, Redis, and Valkey correctness cells. One-rep smoke results are descriptive, not performance gates.                              |
| T3 matrix     | `pnpm perf matrix --profile …`, `pnpm perf libs` | Paired A/B/A-A trials and competitor categories. Results are comparable only within the same environment fingerprint.                                   |
| T4 soak/chaos | `pnpm perf soak`, `pnpm perf chaos`              | Long windows and faults. Full runs are manual because they take hours and require controlled infrastructure.                                            |

T0 includes `group.run` suites that compare `valvejs/group` with a direct valve, plus new-key
churn at `maxSize: 64`. For retained heap per key, churn bounds, and leftover timers, run
`node --expose-gc --import tsx src/micro/group-memory.ts` from this package after
`pnpm --filter valvejs build`. It exits nonzero if the cache exceeds `maxSize` or leaves timers.

The model controls admission state, not JavaScript timers, promise ordering, sockets, or Valve's
runtime scheduler. Scheduler claims therefore come only from real-time T2-T4 runs.

## Read statuses in this order

Every report carries two independent conclusions:

1. **Safety:** `PASS`, `FAIL`, or `UNVERIFIED`. Safety covers rate and lease invariants, aborts,
   lost jobs, and callbacks that start after `maxWait`. A safety failure is never averaged into a
   confidence interval and never becomes a performance regression.
2. **Performance:** `REGRESSION`, `IMPROVEMENT`, `NONINFERIOR`, `EQUIVALENT`, `INCONCLUSIVE`,
   `UNSTABLE`, or `DESCRIPTIVE`, per metric and cell.

`UNVERIFIED` means the run did not contain enough instrumentation to establish an invariant; it
does not mean pass. `DESCRIPTIVE` means fewer than five independent replications. `UNSTABLE`
means the A/A control failed, so the A/B result is downgraded to `INCONCLUSIVE`.

Distributed library runs include separate `valve-audit` correctness trials. Their timings are
excluded from comparisons, and their PASS status does not replace missing coverage in
uninstrumented performance rows. Planned restart audits preserve pre-reset logs outside the
server behind a temporary write pause. See [REPRODUCING.md](./REPRODUCING.md) for coverage
limits and controlled A/A reruns.

## Portable and authoritative runs

Quick/model tiers run anywhere Node runs. Smoke can run on a normal Linux GitHub runner and is
useful correctness evidence, but it is not authoritative performance evidence.

An authoritative run requires Linux, delegated cgroup v2 CPU and memory controls, swap disabled
for the scope, `taskset` CPU isolation, pinned server containers, direct container IPs, and a
stable host. `pnpm perf doctor` records those capabilities. Missing controls do not fabricate a
failure: the manifest records `authoritative: false`, and the report carries a portable-run
banner. Never compare performance across different fingerprints.

## Store safety

The harness never issues `FLUSHALL`. It permits `FLUSHDB` only when a server is recorded in
`.perf/infra.json` and its live `__valve_perf_disposable__` sentinel matches the recorded random
token. `infra up` creates Docker containers labelled `dev.valve.perf=1`; `infra adopt` accepts
only an empty dedicated endpoint. Other URLs use a unique key prefix and cleanup only keys under
that prefix.

Do not point an adopted or disposable endpoint at production, shared development, or valuable
data. Treat `.perf/infra.json` as local safety state, not as a portable configuration file.

## Command reference

```text
pnpm perf doctor
pnpm perf calibrate
pnpm perf infra up|down|status|adopt|images
pnpm perf build [--ref <git-ref>] [--patch <file>]
pnpm perf micro | model | quick
pnpm perf footprint [--check] [--base <ref>]
pnpm perf startup [--base <ref>] [--reps 3]
pnpm perf scoped [--stores memory,redis74] [--iterations 100] [--base <ref>]
pnpm perf drift [--base <ref>] [--jobs 200] [--response-ms 0] [--reps 3]
pnpm perf smoke [--stores redis74,valkey8] [--suite <name>]
pnpm perf plan --profile targeted|nightly|decision [--suite <name>] [--budget 40m]
pnpm perf matrix --profile <profile> --base <ref> [--head <ref>|--current] [--yes]
pnpm perf libs [--category L1,L2,...,D3] [--reps 5]
pnpm perf soak --duration 4h [--suite lease]
pnpm perf chaos [--faults <list>]
pnpm perf c1
pnpm perf report <runId> [--html]
pnpm perf legacy catalog|golden
```

`plan` is the safe first step for a matrix. Estimates over 60 minutes require `--yes`; nightly
selection uses `--budget` and drops lower-priority cells deterministically rather than cutting a
random partial run.

## Deadline regression verification

C1 was fixed in valvejs 0.5.2 by checking positive `maxWait` deadlines immediately before
callback invocation. `pnpm perf c1 --stores memory,redis74,valkey8` verifies the fix against
registered stores. It passes only when the earlier blocking callback finishes, the stall crosses
the later job's deadline, and the later job rejects with `MAX_WAIT_EXCEEDED` without running.

The command exits 0 for verified rejection, 1 for a late callback, and 2 for an inconclusive
probe or setup failure. Unrelated rejection is not a safety pass. Vulnerable historical builds
and their retained reports remain safety failures. See [docs/C1-ISSUE.md](./docs/C1-ISSUE.md).

## Bounded samples and dedicated-host CI

`--window 1s --warmup-ms 0 --drain-ms 100 --reps 1 --limit-cells 1` makes a short
integration sample. Explicitly shortened windows are labelled samples and cannot support the
normal minimum-slot performance claim. Use `--dry-run` before longer work.

The nightly workflow is manual-only until dedicated infrastructure is configured; its default
manual choice is hosted smoke. Before enabling a cron schedule or authoritative runs, configure
a self-hosted Linux runner labelled `valve-perf` and repository variables `PERF_SERVER_CPUS` and
`PERF_WORKER_CPUS` as disjoint CPU lists. Nightly and decision jobs use `--isolate` and
`--require-authoritative`; missing protection fails before trials. Hosted smoke stays portable.

A continuous soak defaults to two offered jobs/second. Raw job/call streams each have a 64 MiB
fleet budget per trial, disk buffering is bounded, and schedules stop at 250,000 fleet arrivals.
Exceeding a budget fails the trial explicitly. These controls make long low-load leak checks
possible without presenting them as unrestricted high-rate stress.

The full smoke profile includes deadline exposure. Any deadline violation fails and stops the
run. PR CI runs memory/Redis/Valkey smoke, real-store integration, and the C1 regression command.

### Independent group bundle budget

The opt-in `valvejs/group` entry has a 19,500-byte gzip source budget. It bundles
`createValve` and the shared memory store plus the group lifecycle. The original
19,000-byte allocation left six bytes after bounded acquisition cleanup. Adding
submission-time scope snapshots, guarded option reads, expiry checks before
child construction, and preservation of inherited option fields requires about
400 more bytes. This separate budget decision
preserves those correctness guarantees and leaves modest room for maintenance.
The core budget remains 17,500 bytes; core, Redis, and headers sizes are unchanged.
This is a new subpath budget, not a relaxation of an existing core release limit.
