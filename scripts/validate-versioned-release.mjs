import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { releaseTag } from './prepare-release-plan.mjs';

/** A consumed beta changeset must accompany a new manifest version and matching release notes. */
export function validateVersionedRelease(pkg, previous, changelog, pre) {
  if (pkg.version === previous.version)
    throw new Error('Archived changesets require a new package version.');
  if (releaseTag(pkg, pre) !== 'beta')
    throw new Error('Archived prerelease changesets require the beta channel.');
  const newest = changelog.match(/^## (\S+)\s*$/m)?.[1];
  if (newest !== pkg.version)
    throw new Error(
      'The newest changelog entry must match the package version.',
    );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const base = process.argv[2];
  if (!base) throw new Error('Usage: validate-versioned-release.mjs BASE_REF');
  const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
  const pkg = json('packages/valve/package.json');
  validateVersionedRelease(
    pkg,
    JSON.parse(
      execFileSync('git', ['show', `${base}:packages/valve/package.json`], {
        encoding: 'utf8',
      }),
    ),
    readFileSync('packages/valve/CHANGELOG.md', 'utf8'),
    json('.changeset/pre.json'),
  );
  console.log(`Validated prepared beta release: ${pkg.name}@${pkg.version}`);
}
