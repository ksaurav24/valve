import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Publish plain versions through npm's default channel. */
export function releaseTag(pkg, preState) {
  const number = '(?:0|[1-9][0-9]*)';
  const version = new RegExp(`^${number}\\.${number}\\.${number}$`);
  if (pkg.name !== 'valvejs') throw new Error('Expected the valvejs package');
  if (!version.test(pkg.version))
    throw new Error(`Expected a plain x.y.z release version: ${pkg.version}`);
  if (preState)
    throw new Error(
      'Finish exiting Changesets prerelease mode before publishing.',
    );
  if (pkg.publishConfig?.tag && pkg.publishConfig.tag !== 'latest') {
    throw new Error(
      'Releases use the default npm channel; remove publishConfig.tag.',
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
