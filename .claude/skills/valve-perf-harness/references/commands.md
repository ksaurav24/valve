# Harness command reference

Run `pnpm perf --help` for the authoritative list from `packages/perf/src/cli.ts`.

```text
pnpm perf doctor | calibrate [--reps 3]
pnpm perf build [--ref REF] [--patch FILE] [--rebuild]
pnpm perf infra up|down|status|images [SERVER,...] [--cpuset CPUS] [--recreate]
pnpm perf infra adopt URL --empty-only [--name NAME]
pnpm perf micro [--quick] [--filter TEXT] | model | quick
pnpm perf footprint [--check] [--base REF] | startup [--base REF] [--reps 3]
pnpm perf scoped [--stores memory,redis74] [--iterations 100] [--base REF]
pnpm perf drift [--base REF] [--jobs 200] [--response-ms 0] [--reps 3]
pnpm perf plan --profile smoke|targeted|sylvie|nightly|decision [--suite NAME,...] [--budget 40m]
pnpm perf smoke | matrix --base REF [--head REF|--current] [--profile targeted]
pnpm perf libs [--category L1,L2,D1] | soak [--duration 4h] | chaos [--faults TYPE,...]
pnpm perf c1 [--stores memory,redis74] | report RUN_ID [--html]
pnpm perf legacy catalog [--archive DIR] | legacy golden
```

Real-time options: `--stores memory,redis74,valkey8`, `--suite NAME,...`,
`--cell TEXT`, `--limit-cells N`, `--window 2s` (alias `--duration`),
`--window-ms N`, `--warmup-ms N`, `--drain-ms N`, `--workers N` (1 to 64),
`--reps N`, `--seed N`, `--rate N` (soak offered jobs/s), `--dry-run`,
`--budget 40m`, `--yes`, `--isolate`, `--worker-cpus CPUS`,
`--require-authoritative`, `--endpoint URL`, `--run-id ID`, `--html`,
`--keep-raw`.

Root shortcuts: `pnpm check:size` = `pnpm perf footprint --check`;
`pnpm perf:sylvie` = `pnpm perf matrix --profile sylvie`.

## Server catalog (`infra up`)

`redis62`, `redis74`, `redis8`, `valkey72`, `valkey8` (Docker containers
labelled `dev.valve.perf=1`, named `valve-perf-<name>`). The `network` suite
needs a `-netem` server; `stores` needs every version.

## Library comparison categories (`libs --category`)

| Id     | Category                 | Competitor |
| ------ | ------------------------ | ---------- |
| L1     | Local concurrency        | p-limit    |
| L2     | Local burst-1 pacing     | bottleneck |
| L3     | Local fixed-window quota | p-queue    |
| L4     | Local burst bank         | bottleneck |
| L5     | Queued cancellation      | p-queue    |
| D1     | Global concurrency       | bottleneck |
| D2     | Global burst-1 pacing    | bottleneck |
| D3     | Global window            | bottleneck |
| V-only | Valve atomic features    | none       |

Distributed categories need harness-owned stores. Bottleneck's burst bank is an
approximation (integral capped refill), noted in reports. One-rep library runs
verify wiring, not performance differences. Distributed valve cells also run a
separate `valve-audit` correctness trial whose timings never enter comparisons.

## Sylvie preset

Named after the calibration laptop (i5-12450H, 16 GB). Compares `HEAD` (base)
against the current checkout: two workers, GCRA 500/s burst 1 and a global
lease workload (concurrency 8, about 20 ms jobs), 10 paired reps, 15 s windows,
2 s warmup, about 21 minutes. `--suite gcra` runs only the rate case.
`--base <ref>` changes the baseline; `--head HEAD` compares identical builds to
check repeatability. Requires Linux CPU topology, cgroups, Docker; provisions
and removes its own Redis 7.4 if none is registered. Plan a larger study with
`pnpm perf:sylvie --reps 20 --dry-run`.

## Locks

Server locks live in `.perf/locks/`. A stale lock is recovered only when its
owner PID is confirmed dead; otherwise the harness fails closed with an
inspection message. Don't delete locks held by running processes.

## CI

`perf-pr.yml` runs portable checks, real-store smoke, C1, scoped probes, and
footprint on relevant PRs. `perf-nightly.yml` and `perf-decision.yml` are
manual until a dedicated `valve-perf` self-hosted runner with
`PERF_SERVER_CPUS` and `PERF_WORKER_CPUS` exists. Hosted results never establish
nonregression.
