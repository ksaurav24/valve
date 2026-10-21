# Benchmark ownership and migration

`packages/perf` owns all active performance tooling. `packages/valve` provides the
library under test, its build, production correctness tests, and packaging checks.
It has no benchmark directory, competitor dependencies, or benchmark commands.
Root commands are convenience entry points into perf; `pnpm check:size` delegates
to `pnpm perf footprint --check`.

## Coverage map

| Previous tool                                                | Current command                                         | Coverage and limits                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------ | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `local.ts`, `mitata.ts`                                      | `pnpm perf micro`, `pnpm perf libs --category L1`       | Tinybench operation costs and cold-process local concurrency comparisons. Old Mitata samples are historical.                                                                                                                                                                 |
| `compare.ts`, `paced.ts`, `redis.ts`, paired runtime scripts | `pnpm perf libs`, `pnpm perf matrix`, `pnpm perf smoke` | Declared workloads, public interfaces, paired builds, A/A controls, separate correctness audits, and explicit unsupported cases. This is a new protocol, not a continuation of the old 42-row sample series.                                                                 |
| `headers.ts`                                                 | `pnpm perf micro --filter headers`                      | Individual Retry-After, IETF, and X-RateLimit readers plus combined feedback.                                                                                                                                                                                                |
| `scoped.ts`                                                  | `pnpm perf scoped --stores memory,redis74,valkey8`      | Batches 1/32/128, rules 2/8/16, cold/hot/mixed identities, expected grant checks, logical key cardinality, and 1/4/8-client shared contention. Uses public `Store.acquireScoped`, without private normalization/key-preparation imports.                                     |
| `drift.mjs`                                                  | `pnpm perf drift --base master --response-ms 5`         | Cold-process public-store pacing, queue wait, accumulated callback drift, CPU, memory, GC, and event-loop delay. The old source-injection trace is archived: internal wake/admission/dispatch timestamps are not available from this probe and are not reported as verified. |
| `bundle-footprint.mjs`, `check-size.mjs`                     | `pnpm perf footprint --check --base master`             | Source and built entry sizes, tree-shaken consumers, per-module attribution, and the source-entry ceilings: core 13,000, Redis 6,300, headers 2,048 gzip bytes. Only the candidate is checked against today's budgets.                                                       |
| `footprint-startup.mjs`                                      | `pnpm perf startup --base master`                       | Three alternating pairs, ten fresh processes per entry and build per pair, all samples retained. Import/init time, CPU, heap delta, RSS, and peak RSS. Filesystem caches are shared.                                                                                         |

`scoped`, `drift`, and `startup` are descriptive diagnostic probes. They do not
produce statistical performance verdicts. Scoped denial evaluations are recorded
separately from useful grants. Contention uses multiple connections in one Node
process, not multiple processes or a production Redis Cluster. The default scoped
probe uses memory; provision named stores with `pnpm perf infra up` before selecting
Redis or Valkey. Every probe uses its own prefix and removes only its keys.

`--base REF` adds a baseline to any of these commands; `--head REF` selects a
candidate revision instead of the working checkout. Both builds finish before
measurement. The current perf implementation and its pinned dependencies measure
both artifacts; no benchmark program is executed from the measured checkout.
Source and dist files are hashed and frozen together so source footprint samples
cannot silently follow edits to the working tree.

Every command writes a manifest, raw JSON, and a short report under `.perf/runs/`.
Manifests record build hashes, the harness hash, host fingerprint, options, and
protocol. The Lua audit adapter reads the matching script source from the frozen
build and verifies its digests. Historical Lua bytecode equivalence measurements
remain historical evidence; current Lua correctness is covered by parity and
real-store audit tests, not an assertion of bytecode equivalence across revisions.

## GitHub Actions

`perf-pr.yml` runs on relevant PRs, pushes to master, and manual dispatch. Change
classification includes perf source, dependencies, workflows, Valve changes, and
shared build tooling. Failed classification fails the selected checks.

- Portable: perf unit tests, typechecking, quick models/microbenchmarks, and a short drift probe.
- Real stores: guarded Redis 7.4/Valkey 8 integration, C1, scoped probes, and smoke cells.
- Footprint: the unchanged deterministic size budgets and descriptive cold-startup samples;
  PR runs measure both the PR baseline and current build using the same harness.

These replace `bench.yml`. Its old 15% pooled-median throughput/timing gates are
retired. Performance decisions now use the harness's preregistered margins,
paired trials, and A/A stability checks on a controlled host. Hosted smoke and
startup results do not establish nonregression. The existing Valve production
test, integration, runtime, and release workflows remain responsible for their checks.

`perf-nightly.yml` and `perf-decision.yml` remain manual until a dedicated
`valve-perf` runner and CPU variables are configured. They enforce authoritative
execution for performance decisions. `sylvie` is a local hardware preset and is
never used on hosted CI runners.

## Historical evidence

The four reports in [history/](./history/) retain their measurements, caveats, and
immutable links to raw evidence. Their original commands are instructions for
the recorded historical checkout, not commands supported by the current tree.
New run data stays under `.perf/`; the external read-only archive and golden
replay are unchanged. No historical sample is relabelled as a result of this migration.
