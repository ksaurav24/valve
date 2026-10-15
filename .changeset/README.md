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

The repository is in prerelease mode with tag `beta`. The current release target
is `0.4.0-beta.0`, following the published v0.3.0 beta series.
Add changesets for subsequent package changes, then run `pnpm version-packages`
for the next beta version and changelog. Install published betas with `npm install valvejs@beta`. The packed
publish plan enforces the `beta` npm tag, and GitHub marks the matching
`valvejs@0.4.0-beta.0` release as a prerelease. The npm trusted publisher must
target `version.yml` in `ksaurav24/valve`.

To prepare a stable release, run `pnpm changeset pre exit`, remove
`publishConfig.tag` (or set it to `latest`), update beta installation
instructions, then run `pnpm version-packages` and review the version PR.
