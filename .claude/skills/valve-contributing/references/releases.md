# Releases and the website changelog

Sources: `CONTRIBUTING.md`, `.changeset/README.md`, `AGENTS.md`, `apps/web/README.md`.

## Flow

1. PRs with user-facing library changes include a changeset.
2. After merge to `master`, automation opens or updates a version PR (package
   version, `packages/valve/CHANGELOG.md`, lockfile). It dispatches CI for the
   bot PR.
3. Merging the version PR publishes `valvejs` to npm through trusted publishing
   (`.github/workflows/version.yml`), creates the `valvejs@x.y.z` tag and GitHub
   Release, waits for npm metadata, then calls `VERCEL_DEPLOY_HOOK`.

Versions are plain `x.y.z` on npm's `latest` channel. "Beta until 1.0"
describes API maturity in READMEs and the website, not a version suffix or
dist-tag. The release guard rejects prerelease versions and custom channels.

## Manual versioning (rare)

```sh
pnpm version-packages              # consume changesets, bump, changelog, format
pnpm --filter @valve/web sync      # regenerate website changelog content
```

## Website changelog rules (from AGENTS.md)

Whenever a changeset is added, edited, removed, or consumed, or a package is
published, update the website changelog in the same work:

- Source of truth: `packages/valve/CHANGELOG.md` and `packages/valve/package.json`.
- Run `pnpm --filter @valve/web sync`. Never hand-edit the gitignored
  `apps/web/content/changelog/` or `.generated/` outputs.
- After an npm publish: verify `npm view valvejs dist-tags`, run
  `pnpm --filter @valve/web sync:snapshot`, and commit
  `apps/web/content/data/metadata.json`. Do not label a beta as stable or invent
  release dates.
- Check `/changelog`, `/releases`, and the homepage changelog show versions in
  newest-first order. Run `pnpm --filter @valve/web test` and `pnpm docs:build`.
