# Repository map

## Workspace

| Path               | What it is                                                                 |
| ------------------ | -------------------------------------------------------------------------- |
| `packages/valve`   | The published `valvejs` library (only published package)                   |
| `packages/perf`    | Private correctness and performance harness (`pnpm perf ...`)              |
| `apps/web`         | Next.js + Fumadocs website: marketing pages, `/docs`, changelog, releases  |
| `examples/*`       | Six small self-checking programs (`pnpm examples`)                         |
| `skills/`          | Public agent skills for valve users                                        |
| `.claude/skills/`  | Internal maintainer skills (this one, perf harness)                        |
| `scripts/`         | Repo tooling: source checks, Lua build, CI change classification, releases |
| `.changeset/`      | Pending changesets and release notes guidance                              |
| `audits/`          | Review notes from past audits                                              |
| `compose.test.yml` | Redis 6.2/7.4/8 and Valkey 7.2/8 for integration tests                     |

## Library source (`packages/valve/src`)

| File                                     | Responsibility                                                                          |
| ---------------------------------------- | --------------------------------------------------------------------------------------- |
| `index.ts`                               | Public exports of the core entry                                                        |
| `types.ts`                               | Public option, job, stats, event types (TSDoc here feeds TypeDoc)                       |
| `valve.ts`                               | `createValve`: scheduler, admission loop, shared pauses, lifecycle, `wrapFetch` retries |
| `queue.ts`                               | FIFO ring that promotes to a priority heap                                              |
| `delayed.ts`                             | Eligibility heap for jobs denied by scoped rules                                        |
| `rules.ts`                               | Option validation and stable rule normalization                                         |
| `algorithms.ts`                          | Pure GCRA and fixed-window batch math, mirrored by Lua                                  |
| `scoped.ts`                              | Scoped requests and collision-free identity keys shared by both stores                  |
| `managed.ts`                             | Managed limits: fingerprints, patch validation, virtual-time GCRA, mirrored by Lua      |
| `memory-store.ts`                        | In-process store; reference implementation of the store contract                        |
| `store.ts`                               | `Store` and managed store contracts                                                     |
| `leases.ts`                              | Global concurrency lease renewal and release batching                                   |
| `sequential.ts`                          | `runSequential`                                                                         |
| `fetch-body.ts`                          | Bounded `Request` body probing for replay                                               |
| `emitter.ts`, `errors.ts`, `duration.ts` | Events, `ValveError` and messages, duration parsing                                     |
| `headers/`                               | Feedback readers (`retryAfter`, `ietfRateLimit`, `xRateLimit`, `combine`)               |
| `redis/index.ts`                         | `redisStore`: script cache, timeouts, adapters                                          |
| `redis/*.lua`                            | Atomic scripts: `acquire`, `scoped`, `managed`, `pause`, `resume`, `release`, `renew`   |
| `redis/scripts.ts`                       | **Generated** minified Lua plus SHA1 (`scripts/lua-sha.mjs`), do not edit               |
| `redis/clients.ts`, `subscriptions.ts`   | Structural client detection, pub/sub multiplexing                                       |
| `group/index.ts`                         | `createValveGroup` (opt-in `valvejs/group` entry)                                       |

Entries built by tsdown (ESM + CJS + d.ts): `index`, `headers/index`,
`redis/index`, `group/index`, platform `neutral`, target `es2022`.

## Tests (`packages/valve/test`)

- `*.test.ts`: unit and property tests (vitest, fast-check). Notable:
  `scheduler.test.ts`, `fetch*.test.ts`, `scoped.test.ts`, `managed*.test.ts`,
  `group*.test.ts`, `sequential.test.ts`, `global.test.ts`.
- `types.test-d.ts`: type inference (`pnpm test:types`).
- `integration/*.integration.test.ts`: real Redis/Valkey: Lua parity, multiprocess
  bounds (child-process workers), pauses, recovery, replay after timeouts,
  cluster. Run serially with `REDIS_URL`.

## Design principles to preserve

- One atomic store operation decides admission for every rule (and leases).
  Never split an admission into several store calls.
- All rate math uses the store clock (Redis `TIME`), never the caller's.
- Unscoped admission grants a queue prefix. Scoped admission can skip blocked
  identities so ready jobs proceed; each denied job spends nothing.
- Fail closed on configuration mismatch, under every `onStoreError` policy.
- The library never owns user clients: it does not open, configure, or close
  Redis connections it was given.
- Zero dependencies and web-standard APIs in core keep it portable and small.
- Docs state bounds exactly; when unsure, say less and test more.
