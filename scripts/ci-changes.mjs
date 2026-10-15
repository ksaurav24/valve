import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';

const all = { library: true, package: true, website: true, benchmarks: true };

export function isReleaseOnlyChange(before, after) {
  const previous = structuredClone(before);
  const current = structuredClone(after);
  delete previous.version;
  delete current.version;
  if (isDeepStrictEqual(previous, current)) return true;
  const tag = after.publishConfig?.tag ?? 'latest';
  const validChannel =
    tag === 'beta'
      ? /^\d+\.\d+\.\d+-beta\.\d+$/.test(after.version)
      : tag === 'latest' && /^\d+\.\d+\.\d+$/.test(after.version);
  if (
    !validChannel ||
    !['latest', 'beta'].includes(before.publishConfig?.tag ?? 'latest')
  )
    return false;
  for (const pkg of [previous, current]) {
    if (pkg.publishConfig) {
      delete pkg.publishConfig.tag;
      if (Object.keys(pkg.publishConfig).length === 0) delete pkg.publishConfig;
    }
  }
  return isDeepStrictEqual(previous, current);
}

/** Classify actual files, never PR titles or labels that could hide code changes. */
export function classifyChanges(paths, versionOnly = false) {
  const checks = {
    library: false,
    package: false,
    website: false,
    benchmarks: false,
    changeset: false,
  };
  for (const path of paths) {
    if (path === 'packages/valve/package.json' && versionOnly) {
      checks.package = checks.website = true;
    } else if (path === '.changeset/pre.json') {
      checks.package = true;
    } else if (
      /^packages\/valve\/(README\.md|CHANGELOG\.md|LICENSE|NOTICE)$/.test(path)
    ) {
      checks.package = checks.website = true;
    } else if (
      path.startsWith('packages/valve/bench/') ||
      /^scripts\/.*(bench|footprint)/.test(path)
    ) {
      if (!/\.(md|json)$/.test(path)) checks.benchmarks = true;
    } else if (path.startsWith('packages/valve/')) {
      Object.assign(checks, all);
      if (
        !path.startsWith('packages/valve/test/') &&
        !/\/vitest[^/]*\.ts$/.test(path)
      )
        checks.changeset = true;
    } else if (
      path.startsWith('apps/web/') ||
      path === 'CONTRIBUTING.md' ||
      path === 'README.md'
    ) {
      checks.website = true;
    } else if (
      /^\.github\/workflows\/(test|runtime|bench|changes)\.yml$/.test(path) ||
      path.startsWith('scripts/ci-changes')
    ) {
      Object.assign(checks, all);
    } else if (
      path.startsWith('.github/') ||
      /^\.changeset\/(?:pre\/)?[^/]+\.md$/.test(path) ||
      /\.(md|txt)$/.test(path) ||
      /^(LICENSE|NOTICE)$/.test(path)
    ) {
      // Repository maintenance and release notes do not exercise the library.
    } else {
      // Shared dependencies, build scripts, examples, and unknown paths stay conservative.
      Object.assign(checks, all);
    }
  }
  return checks;
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

export function detectChanges(eventName, baseSha, refName) {
  // Bot version PRs use workflow_dispatch because GITHUB_TOKEN cannot trigger PR CI.
  const base =
    eventName === 'pull_request'
      ? baseSha
      : eventName === 'workflow_dispatch' &&
          refName === 'changeset-release/master'
        ? 'origin/master'
        : null;
  if (eventName === 'pull_request' && !base)
    throw new Error('Missing PR base SHA');
  if (!base) return { ...all, changeset: false };
  const mergeBase = git('merge-base', base, 'HEAD').trim();
  const paths = git(
    'diff',
    '--name-only',
    '--no-renames',
    '-z',
    mergeBase,
    'HEAD',
  )
    .split('\0')
    .filter(Boolean);
  let versionOnly = false;
  if (paths.includes('packages/valve/package.json')) {
    const before = JSON.parse(
      git('show', `${mergeBase}:packages/valve/package.json`),
    );
    const after = JSON.parse(
      readFileSync('packages/valve/package.json', 'utf8'),
    );
    versionOnly = isReleaseOnlyChange(before, after);
  }
  return classifyChanges(paths, versionOnly);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const checks = detectChanges(
    process.env.CI_EVENT_NAME,
    process.env.CI_BASE_SHA,
    process.env.CI_REF_NAME,
  );
  const output =
    Object.entries(checks)
      .map(([name, value]) => `${name}=${value}`)
      .join('\n') + '\n';
  console.log(output);
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, output);
}
