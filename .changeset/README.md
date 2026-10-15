# Changesets

Run `pnpm changeset` for a package change and choose a patch, minor, or major
release with a summary for its changelog. Commit the generated Markdown file.
CI, chore, documentation, test, and tooling changes do not need empty changesets.
Include a changeset when changing published library code, package metadata,
or library build configuration, even with a `chore:` or `ci:` PR title.

The public npm package is `valvejs` in `packages/valve`. The private root
workspace, website, and examples are never published.

After changesets reach `master`, automation opens or updates a version PR with
package versions, changelogs, and the lockfile as needed. It does not refresh
live website metadata or format unrelated files. Version-only changes do not
require another changeset. Merging that PR publishes `valvejs` through npm
trusted publishing and creates the git tag and GitHub Release.

Releases use plain `x.y.z` versions and npm's default `latest` channel.
Install with `npm install valvejs`; there is no separate beta install channel.
The project is **beta until 1.0**, which describes API maturity rather than
version syntax. Keep that notice in the READMEs and website.

Run `pnpm version-packages` to consume changesets and generate the next version
and changelog. The publish-plan guard rejects prerelease versions, Changesets
prerelease mode, and custom npm channels. Git tags and GitHub releases use
`valvejs@x.y.z`; new GitHub releases are not marked as prereleases. The npm
trusted publisher must target `version.yml` in `ksaurav24/valve`.

After versioning, run `pnpm --filter @valve/web sync` and review the website
changelog. After publication, verify `npm view valvejs dist-tags`, refresh the
committed fallback with `pnpm --filter @valve/web sync:snapshot`, and rebuild
the website. Published versions and release dates must come from npm.

For the one-time migration from numbered betas, publish the prepared plain
version before removing the obsolete npm channel with
`npm dist-tag rm valvejs beta` from an authenticated maintainer session.
Verify `latest` points to the new version first. Existing prerelease versions,
Git tags, GitHub releases, and changelog entries remain available; users who
installed with `@beta` should switch to `npm install valvejs`.
