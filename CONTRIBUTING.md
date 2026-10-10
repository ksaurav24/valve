# Contributing to valve

## Development

Use Node.js 24 and pnpm 11.28.4. Install pnpm with your preferred package manager,
then run `pnpm install`. Git hooks are installed automatically.

## Pull request workflow

1. Fork [ksaurav24/valve](https://github.com/ksaurav24/valve) to your GitHub account.
2. Clone your fork and add the original repository as upstream:

   ```sh
   git clone https://github.com/YOUR_USERNAME/valve.git
   cd valve
   git remote add upstream https://github.com/ksaurav24/valve.git
   ```

3. Create a branch from the latest upstream `master`:

   ```sh
   git fetch upstream
   git switch -c fix/42-short-description upstream/master
   ```

4. Make your changes, run `pnpm format` and `pnpm check`, and commit.
5. Push your branch with `git push -u origin fix/42-short-description`.
6. Open a pull request **from your fork into `ksaurav24/valve:master`**. Describe the change, link the issue (for example, `Closes #42`), and ensure checks pass.

**Preferred branch naming:** `<type>/<issue-number>-<short-description>`.
Examples: `feat/12-add-provider-feedback`, `fix/42-scheduler-timing`, `docs/15-update-quickstart`, `refactor/38-simplify-queue`, `test/51-add-gcra-tests`, and `chore/24-update-dependencies`. Issue numbers are preferred when a related issue exists, but are not mandatory; `docs/improve-readme` is also valid. Branch naming is not enforced.

`pnpm check` includes tests, types, builds, source conventions, packaging, and measured bundle regression ceilings.

The repository is a pnpm monorepo. Library packages will live in `packages/*`
and use the `@ksaurav24` scope. The library lives in `packages/valve`, with an website in `apps/web/` and
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
Merging a version PR publishes to npm through trusted publishing, then creates
the git tag and GitHub Release. The first public release is 1.0.0.

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
search index into `apps/web/out/`. After `pnpm docs:build`, run
`pnpm --filter @valve/web test:browser` for browser checks. Install Chromium
with `pnpm --filter @valve/web exec playwright install chromium` first.

See `packages/valve/bench/COMPARISON.md` for measured targets that remain open.

## Performance

Run `pnpm bench:compare` for repeated comparisons with Bottleneck, p-limit and
p-queue. Set `REDIS_URL` and `VALKEY_URL` to include shared-store cases. Raw
results and workload limitations live in `packages/valve/bench/COMPARISON.md`.
Run benchmarks without builds or tests competing for CPU.
