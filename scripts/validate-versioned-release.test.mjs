import assert from 'node:assert/strict';
import test from 'node:test';
import { validateVersionedRelease } from './validate-versioned-release.mjs';

const pkg = { name: 'valvejs', version: '0.4.0' };
const previous = { version: '0.4.0-beta.0' };
const changelog =
  '# valvejs\n\n## 0.4.0\n\n### Minor Changes\n\n- Atomic scoped limits.\n\n## 0.4.0-beta.0\n';

test('the plain release advances beyond the published beta', () => {
  assert.doesNotThrow(() => validateVersionedRelease(pkg, previous, changelog));
});

test('prepared releases require matching release notes', () => {
  for (const notes of ['', '# valvejs\n\n## 0.4.0-beta.0\n']) {
    assert.throws(
      () => validateVersionedRelease(pkg, previous, notes),
      /newest changelog/,
    );
  }
});

test('prepared releases cannot restore custom channels or prerelease mode', () => {
  assert.throws(
    () =>
      validateVersionedRelease(
        { ...pkg, publishConfig: { tag: 'beta' } },
        previous,
        changelog,
      ),
    /default npm channel/,
  );
  assert.throws(
    () =>
      validateVersionedRelease(pkg, previous, changelog, {
        mode: 'pre',
        tag: 'beta',
      }),
    /Finish exiting/,
  );
  assert.throws(
    () =>
      validateVersionedRelease(
        { ...pkg, version: '0.4.1-beta' },
        previous,
        changelog,
      ),
    /plain x.y.z/,
  );
});

test('prepared releases reject equal versions and every form of downgrade', () => {
  for (const [version, oldVersion] of [
    ['0.4.0', '0.4.0'],
    ['0.4.0', '0.4.1'],
    ['0.4.0', '0.5.0-beta.0'],
    ['0.4.0', '1.0.0'],
    ['0.9.0', '0.10.0'],
    ['0.4.0-beta.2', '0.4.0-beta.10'],
  ]) {
    assert.throws(
      () =>
        validateVersionedRelease(
          { ...pkg, version },
          { version: oldVersion },
          `# valvejs\n\n## ${version}\n`,
        ),
      /greater than the previous version/,
      `${oldVersion} -> ${version}`,
    );
  }
});

test('normal version components compare numerically', () => {
  for (const [version, oldVersion] of [
    ['0.4.1', '0.4.0'],
    ['0.4.10', '0.4.2'],
    ['0.10.0', '0.9.0'],
    ['1.0.0', '0.99.0'],
  ]) {
    assert.doesNotThrow(
      () =>
        validateVersionedRelease(
          { ...pkg, version },
          { version: oldVersion },
          `# valvejs\n\n## ${version}\n`,
        ),
      `${oldVersion} -> ${version}`,
    );
  }
});
