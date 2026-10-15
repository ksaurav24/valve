import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Keep npm's channel consistent with the manifest and Changesets prerelease state. */
export function releaseTag(pkg, preState) {
  const number = '(?:0|[1-9][0-9]*)';
  const stable = new RegExp(`^${number}\\.${number}\\.${number}$`);
  const beta = new RegExp(
    `^${number}\\.${number}\\.${number}-beta\\.${number}$`,
  );
  if (pkg.name !== 'valvejs') throw new Error('Expected the valvejs package');
  if (beta.test(pkg.version)) {
    if (
      preState?.mode !== 'pre' ||
      preState.tag !== 'beta' ||
      pkg.publishConfig?.tag !== 'beta'
    ) {
      throw new Error(
        'Beta releases require Changesets beta mode and publishConfig.tag=beta',
      );
    }
    return 'beta';
  }
  if (!stable.test(pkg.version))
    throw new Error(`Unsupported release version: ${pkg.version}`);
  if (preState?.mode === 'pre')
    throw new Error(
      'Run pnpm version-packages to generate a beta version before publishing',
    );
  if (pkg.publishConfig?.tag && pkg.publishConfig.tag !== 'latest') {
    throw new Error(
      'Stable releases require publishConfig.tag=latest (or no explicit tag)',
    );
  }
  return 'latest';
}

export function prepareReleasePlan(plan, pkg, preState) {
  if (
    plan?.version !== 1 ||
    !Array.isArray(plan.plan) ||
    !plan.plan.every(Array.isArray)
  ) {
    throw new Error('Expected a Changesets v1 publish plan');
  }
  const tag = releaseTag(pkg, preState);
  return {
    ...plan,
    plan: plan.plan.map((group) =>
      group.map((release) => {
        if (release.kind !== 'publish') return release;
        if (release.name !== pkg.name || release.version !== pkg.version) {
          throw new Error(
            `Unexpected package in publish plan: ${release.name}@${release.version}`,
          );
        }
        return { ...release, tag };
      }),
    ),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const path = process.argv[2];
  if (!path)
    throw new Error('Usage: prepare-release-plan.mjs PUBLISH_PLAN.json');
  const pkg = JSON.parse(readFileSync('packages/valve/package.json', 'utf8'));
  let preState;
  try {
    preState = JSON.parse(readFileSync('.changeset/pre.json', 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const plan = prepareReleasePlan(
    JSON.parse(readFileSync(path, 'utf8')),
    pkg,
    preState,
  );
  writeFileSync(path, JSON.stringify(plan, null, 2) + '\n');
  console.log(
    `Publish plan: ${pkg.name}@${pkg.version} → ${releaseTag(pkg, preState)}`,
  );
}
