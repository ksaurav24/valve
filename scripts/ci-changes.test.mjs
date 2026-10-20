import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { classifyChanges, isReleaseOnlyChange } from './ci-changes.mjs';

test('migrating from beta to plain versions is a release-only change', () => {
  const before = {
    name: 'valvejs',
    version: '0.4.0-beta.0',
    publishConfig: { access: 'public', tag: 'beta' },
  };
  const after = {
    ...before,
    version: '0.4.0',
    publishConfig: { access: 'public' },
  };
  assert.equal(isReleaseOnlyChange(before, after), true);
  assert.equal(
    isReleaseOnlyChange(after, { ...after, version: '0.4.1' }),
    true,
  );
  assert.equal(
    isReleaseOnlyChange(before, { ...after, name: 'another-package' }),
    false,
  );
  assert.equal(
    isReleaseOnlyChange(before, { ...after, dependencies: { dep: '1.0.0' } }),
    false,
  );
  assert.equal(
    isReleaseOnlyChange(before, {
      ...after,
      publishConfig: { access: 'restricted', tag: 'beta' },
    }),
    false,
  );
  assert.equal(isReleaseOnlyChange(after, before), false);
  assert.equal(before.version, '0.4.0-beta.0');
});

test('CI and chore maintenance does not require release notes or library tests', () => {
  assert.deepEqual(
    classifyChanges(['.github/workflows/ci.yml', '.github/dependabot.yml']),
    {
      library: false,
      package: false,
      website: false,
      benchmarks: false,
      changeset: false,
    },
  );
});

test('documentation runs website checks without library suites', () => {
  const result = classifyChanges([
    'apps/web/content/docs/quickstart.mdx',
    'CONTRIBUTING.md',
  ]);
  assert.equal(result.website, true);
  assert.equal(result.library, false);
  assert.equal(result.changeset, false);
});

test('version-only release PRs keep package and website validation', () => {
  assert.deepEqual(
    classifyChanges(
      [
        'packages/valve/package.json',
        'packages/valve/CHANGELOG.md',
        '.changeset/fix.md',
        '.changeset/pre/fix.md',
        '.changeset/pre.json',
      ],
      true,
    ),
    {
      library: false,
      package: true,
      website: true,
      benchmarks: false,
      changeset: false,
    },
  );
});

test('code changes mixed into a version PR still require all suites and a changeset', () => {
  const result = classifyChanges(
    ['packages/valve/package.json', 'packages/valve/src/valve.ts'],
    true,
  );
  assert.ok(Object.values(result).every(Boolean));
});

test('dependency and shared tooling changes run full checks without forcing a release', () => {
  for (const path of [
    'pnpm-lock.yaml',
    'package.json',
    'scripts/lua-sha.mjs',
    'examples/shared/index.ts',
  ]) {
    const result = classifyChanges([path]);
    assert.equal(result.library, true, path);
    assert.equal(result.benchmarks, true, path);
    assert.equal(result.changeset, false, path);
  }
  assert.equal(
    classifyChanges(['packages/valve/package.json']).changeset,
    true,
  );
});

test('changes to test selection and test workflows exercise all suites', () => {
  for (const path of [
    'scripts/ci-changes.mjs',
    '.github/workflows/changes.yml',
    '.github/workflows/test.yml',
  ]) {
    assert.equal(classifyChanges([path]).library, true, path);
  }
});

test('test-only and benchmark-only work does not force package releases', () => {
  assert.equal(
    classifyChanges(['packages/valve/test/valve.test.ts']).changeset,
    false,
  );
  assert.deepEqual(classifyChanges(['packages/valve/bench/local.ts']), {
    library: false,
    package: false,
    website: false,
    benchmarks: true,
    changeset: false,
  });
});

test('perf owns benchmark selection without triggering library releases', () => {
  for (const path of [
    'packages/perf/src/measure/bundle.ts',
    'packages/perf/package.json',
    '.github/workflows/perf-pr.yml',
  ]) {
    assert.deepEqual(classifyChanges([path]), {
      library: false,
      package: false,
      website: false,
      benchmarks: true,
      changeset: false,
    });
  }
  assert.equal(
    classifyChanges(['packages/perf/docs/history/SCOPED.md']).benchmarks,
    false,
  );
});

test('git detection distinguishes version bumps, metadata edits, deletions, and manual runs', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'valve-ci-'));
  const script = new URL('./ci-changes.mjs', import.meta.url).pathname;
  const git = (...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const detect = (event, base = '', ref = '') =>
    Object.fromEntries(
      execFileSync(process.execPath, [script], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          GITHUB_OUTPUT: '',
          CI_EVENT_NAME: event,
          CI_BASE_SHA: base,
          CI_REF_NAME: ref,
        },
      })
        .trim()
        .split('\n')
        .map((line) =>
          line
            .split('=')
            .map((value, index) => (index ? value === 'true' : value)),
        ),
    );
  try {
    git('init', '--quiet');
    git('config', 'user.name', 'CI test');
    git('config', 'user.email', 'ci@example.com');
    mkdirSync(join(cwd, 'packages/valve/src'), { recursive: true });
    const manifest = join(cwd, 'packages/valve/package.json');
    writeFileSync(
      manifest,
      JSON.stringify({ name: 'valvejs', version: '0.2.0' }),
    );
    writeFileSync(join(cwd, 'packages/valve/src/index.ts'), 'export {};\n');
    git('add', '.');
    git('commit', '--quiet', '-m', 'initial');
    const base = git('rev-parse', 'HEAD');
    git('update-ref', 'refs/remotes/origin/master', base);
    writeFileSync(
      manifest,
      JSON.stringify({ name: 'valvejs', version: '0.3.0' }),
    );
    git('commit', '--quiet', '-am', 'chore: version packages');
    assert.equal(detect('pull_request', base).library, false);
    assert.equal(
      detect('workflow_dispatch', '', 'changeset-release/master').library,
      false,
    );
    assert.equal(detect('workflow_dispatch', '', 'master').library, true);
    assert.equal(detect('push').library, true);
    writeFileSync(
      manifest,
      JSON.stringify({ name: 'other', version: '0.3.0' }),
    );
    git('commit', '--quiet', '-am', 'chore: rename');
    assert.equal(detect('pull_request', base).changeset, true);
    git('reset', '--quiet', '--hard', base);
    git('mv', 'packages/valve/src/index.ts', 'README.md');
    git('commit', '--quiet', '-m', 'docs: move code');
    assert.equal(detect('pull_request', base).library, true);
    assert.throws(() => detect('pull_request'));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
