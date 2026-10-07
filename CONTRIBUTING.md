# Contributing to valve

## Development

Use Node.js 24 and pnpm 11.28.4. Install pnpm with your preferred package manager,
then run `pnpm install`. Git hooks are installed automatically.

Create a branch from `master` and open a pull request when the change is ready.
Run `pnpm lint`, `pnpm typecheck`, and `pnpm build` before submitting it.
Use `pnpm format` to format files.

The repository is a pnpm monorepo. Library packages will live in `packages/*`
and use the `@ksaurav24` scope. Only workspace tooling exists initially;
recursive typecheck and build commands run package scripts once packages exist.

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
