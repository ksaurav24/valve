# Changesets

Run `pnpm changeset` for a package change and choose a patch, minor, or major
release with a summary for its changelog. Commit the generated Markdown file.
For tooling or documentation changes, use `pnpm changeset --empty`.

Packages will use the `@ksaurav24` scope. There are no library packages yet.
The private root workspace is never published.

After changesets reach `master`, automation opens or updates a version PR with
package versions and changelogs. Merging that PR does not publish to npm.
Publishing will be configured later.
