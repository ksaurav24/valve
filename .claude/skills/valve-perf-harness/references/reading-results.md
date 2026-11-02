# Reading harness results and producing evidence

Sources: `packages/perf/README.md`, `packages/perf/REPRODUCING.md`,
`packages/perf/RFC.md` (binding statistics).

## Evidence tiers

| Tier          | Commands         | What it can claim                                                                  |
| ------------- | ---------------- | ---------------------------------------------------------------------------------- |
| T0 micro      | `micro`          | In-process operation costs. Nothing about distributed behavior or Lua correctness. |
| T1 model      | `model`          | Pure admission-state model, parity, capacity bounds. Not a scheduler simulation.   |
| T2 smoke      | `smoke`          | Short real-time correctness on memory, Redis, Valkey. One-rep: descriptive only.   |
| T3 matrix     | `matrix`, `libs` | Paired A/B/A-A trials. Comparable only within one environment fingerprint.         |
| T4 soak/chaos | `soak`, `chaos`  | Long windows and faults; manual, controlled infrastructure.                        |

Scheduler claims come only from real-time T2 to T4 runs; T0 and T1 do not model
JavaScript timers, promise ordering, or sockets.

## Statuses

Safety (per run): `PASS`, `FAIL`, `UNVERIFIED`. Covers rate and lease
invariants, aborts, lost jobs, and callbacks starting after `maxWait`. A FAIL is
never averaged away and never becomes a "regression".

Performance (per metric and cell):

| Status         | Meaning                                              |
| -------------- | ---------------------------------------------------- |
| `REGRESSION`   | Candidate worse beyond the preregistered margin      |
| `IMPROVEMENT`  | Candidate better beyond the margin                   |
| `NONINFERIOR`  | Not worse than the margin                            |
| `EQUIVALENT`   | Within the equivalence margin both ways              |
| `INCONCLUSIVE` | Not enough evidence either way                       |
| `UNSTABLE`     | A/A control failed; A/B downgraded to INCONCLUSIVE   |
| `DESCRIPTIVE`  | Fewer than five independent replications; no verdict |

## Authoritative runs

Need Linux, delegated cgroup v2 CPU and memory, swap disabled for the scope,
`taskset` isolation, pinned server containers, direct container IPs, and a
stable host. Missing controls record `authoritative: false` and a portable-run
banner. Use `--require-authoritative` to fail fast instead.

Example of a controlled repeatability check (identical builds):

```sh
pnpm perf infra up redis74 --cpuset 6
pnpm perf matrix --profile targeted --suite gcra --cell sat-1w-100-b1 \
  --base HEAD --head HEAD --reps 10 --window 10s --warmup-ms 500 --drain-ms 200 \
  --stores redis74 --worker-cpus 4 --isolate --require-authoritative --html
```

Verify the machine's CPU topology before choosing CPUs. `infra up` reuses an
existing container; recreate a harness-owned one (`--recreate`) if its CPU
assignment differs.

## Before citing a result

Record: run id and source commit; manifest and environment fingerprint hashes;
base and candidate build identities (including patch hashes); server images and
whether the run was authoritative; safety status separately from each
performance verdict; skipped, censored, retried, resource-invalid, or
generator-saturated trials. Archive the whole `.perf/runs/<runId>/` directory,
not just the HTML.

## Do not

- Compare summaries whose manifests differ in environment, build, suite, cell,
  plan, margin, or seed hashes.
- Widen margins, drop valid trials, or rerun until you get the verdict you want.
- Treat hosted-CI or laptop smoke timings as nonregression evidence.
- Run measurements while builds, tests, or other heavy work compete for CPU.
- Claim managed-limits performance from the main immutable matrix workloads.
  The standalone `src/measure/managed.ts` admission probe is diagnostic only.
