# Repository instructions

## Website changelog

Whenever a changeset is added, edited, removed, or consumed by versioning, or an
npm package is published, update the website changelog as part of the same work.

- Use `packages/valve/CHANGELOG.md` as the source for versioned release notes and
  `packages/valve/package.json` for the current version. Preserve Changesets'
  versioning workflow and keep pending changes accurately described in changesets.
- Run `pnpm --filter @valve/web sync` to regenerate the website content. Do not
  hand-edit the gitignored `content/changelog/` or `.generated/` outputs.
- After an npm publish, run `pnpm --filter @valve/web sync:snapshot` and commit
  `apps/web/content/data/metadata.json` so published releases remain visible when
  the npm or GitHub APIs are unavailable. Verify the published version and npm
  tag; do not label a beta as stable or invent release dates.
- Check that `/changelog`, `/releases`, and the homepage changelog show the
  expected versions in the package changelog's newest-first order. Run
  `pnpm --filter @valve/web test` and `pnpm docs:build` before finishing, and ensure
  the website is rebuilt after publication.
