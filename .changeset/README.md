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
trusted publishing and creates the git tag and GitHub Release. CI and package-name
maintenance uses an empty changeset and ships with the planned v0.3.0 release.
The npm trusted publisher must target `version.yml` in
`ksaurav24/valve`.
