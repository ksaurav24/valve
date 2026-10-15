import assert from 'node:assert/strict';
import test from 'node:test';
import { validateVersionedRelease } from './validate-versioned-release.mjs';

const pkg = {
  name: 'valvejs',
  version: '0.4.0-beta.0',
  publishConfig: { tag: 'beta' },
};
const previous = { version: '0.3.0-beta.1' };
const pre = { mode: 'pre', tag: 'beta' };
const changelog =
  '# valvejs\n\n## 0.4.0-beta.0\n\n### Minor Changes\n\n- Atomic scoped limits.\n\n## 0.3.0-beta.1\n';

test('consumed beta changesets can accompany the prepared feature release', () => {
  assert.doesNotThrow(() =>
    validateVersionedRelease(pkg, previous, changelog, pre),
  );
});
test('archiving a changeset alone cannot satisfy package release validation', () => {
  assert.throws(
    () => validateVersionedRelease(pkg, pkg, changelog, pre),
    /new package version/,
  );
  assert.throws(
    () =>
      validateVersionedRelease(
        pkg,
        previous,
        '# valvejs\n\n## 0.3.0-beta.1\n',
        pre,
      ),
    /newest changelog/,
  );
  assert.throws(
    () => validateVersionedRelease(pkg, previous, '', pre),
    /newest changelog/,
  );
});
test('prepared beta releases retain the prerelease publishing guard', () => {
  assert.throws(
    () =>
      validateVersionedRelease(
        { ...pkg, publishConfig: { tag: 'latest' } },
        previous,
        changelog,
        pre,
      ),
    /Beta releases require/,
  );
  assert.throws(
    () =>
      validateVersionedRelease(pkg, previous, changelog, {
        mode: 'exit',
        tag: 'beta',
      }),
    /Beta releases require/,
  );
});

test('prepared releases reject equal versions and every form of downgrade', () => {
  for (const [version, oldVersion] of [
    ['0.4.0-beta.0', '0.4.0-beta.0'],
    ['0.4.0-beta.0', '0.4.0-beta.1'],
    ['0.4.0-beta.2', '0.4.0-beta.10'],
    ['0.4.0-beta.0', '0.4.0'],
    ['0.4.0-beta.0', '0.5.0-beta.0'],
    ['0.4.0-beta.0', '1.0.0'],
  ]) {
    assert.throws(
      () =>
        validateVersionedRelease(
          { ...pkg, version },
          { version: oldVersion },
          `# valvejs\n\n## ${version}\n`,
          pre,
        ),
      /greater than the previous version/,
      `${oldVersion} -> ${version}`,
    );
  }
});

test('prepared releases compare beta identifiers and version components numerically', () => {
  for (const [version, oldVersion] of [
    ['0.4.0-beta.10', '0.4.0-beta.2'],
    ['0.4.0-beta.0', '0.3.0'],
    ['0.10.0-beta.0', '0.9.0-beta.20'],
    ['1.0.0-beta.0', '0.99.0'],
  ]) {
    assert.doesNotThrow(
      () =>
        validateVersionedRelease(
          { ...pkg, version },
          { version: oldVersion },
          `# valvejs\n\n## ${version}\n`,
          pre,
        ),
      `${oldVersion} -> ${version}`,
    );
  }
});
