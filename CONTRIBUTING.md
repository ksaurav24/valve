# Contributing to valve

## Development

Use Node.js 24 and pnpm 11.28.4. Install pnpm with your preferred package manager,
then run `pnpm install`. Git hooks are installed automatically.

Create a branch from `master` and open a pull request when the change is ready.
Run `pnpm check` before submitting it. It includes tests, types, builds, source
conventions, packaging, and measured bundle regression ceilings.
Use `pnpm format` to format files.

The repository is a pnpm monorepo. Library packages will live in `packages/*`
and use the `@ksaurav24` scope. The 0.1.0 library lives in `packages/valve`, with an MDX site in `docs/` and
runnable use cases in `examples/`.

New TypeScript packages should extend the root `tsconfig.base.json` and provide
`typecheck` and `build` scripts. ESLint covers JavaScript and TypeScript across
the workspace. The root package is private.

## Commit conventions

Use Conventional Commits for commits and pull request titles:

- `feat: add a capability`
- `fix: correct a bug`
- `docs: update documentation`
- `chore: maintain tooling`
- `feat!: introduce a breaking change`

Optional scopes are welcome, for example `fix(core): handle an empty input`.
Use a `BREAKING CHANGE:` footer when more explanation is needed.
Local hooks validate commits; CI validates PR titles. Pull requests are squash
merged, with the PR title used as the resulting commit subject.

## Versions and changelogs

Run `pnpm changeset` for user-facing package changes. Choose `patch` for fixes,
`minor` for compatible features, and `major` for breaking changes. Describe the
change for package users. Changesets determines SemVer bumps from these files;
commit types alone do not determine release versions.

For documentation and tooling changes, run `pnpm changeset --empty`.
Version PRs are exempt from requiring a new changeset.
Automation opens version/changelog PRs after changesets merge into `master`.
It explicitly dispatches CI for bot-created PRs so required checks can run.
There is no publishing workflow yet.

## Conduct and license

Follow [the Code of Conduct](CODE_OF_CONDUCT.md). Report conduct concerns
privately to ksaurav4093@gmail.com.

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE).

## Real stores and docs

Use `compose.test.yml` to run Redis and Valkey locally. Set `REDIS_URL` for
`pnpm test:integration`, `REDIS_CLUSTER_URL` for cluster checks, and
`REDIS_SERVER_BIN` for an isolated stop/restart fixture. Use `pnpm examples`
to run all six use cases after building the library.

Run `pnpm docs:dev` for the Next.js and Fumadocs MDX site at
`http://127.0.0.1:4321`. `pnpm docs:build` exports static pages and a local
search index into `docs/out/`. After `pnpm docs:build`, run
`pnpm --filter @valve/docs test:browser` for browser checks. Install Chromium
with `pnpm --filter @valve/docs exec playwright install chromium` first.

See `packages/valve/bench/RESULTS.md` for measured targets that remain open.
Keep `pvt/` untracked; source checks use the tracked TODO register for CI.

## Code navigation and performance

Install CodeGraph separately, then run `codegraph init --yes` once and
`pnpm codegraph:sync` after changes. The local `.codegraph/` index is ignored;
private `pvt/` material must remain ignored and untracked.

Run `pnpm bench:compare` for repeated comparisons with Bottleneck, p-limit and
p-queue. Set `REDIS_URL` and `VALKEY_URL` to include shared-store cases. Raw
results and workload limitations live in `packages/valve/bench/COMPARISON.md`.
Run benchmarks without builds or tests competing for CPU.
