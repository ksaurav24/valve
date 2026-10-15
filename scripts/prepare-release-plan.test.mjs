import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareReleasePlan, releaseTag } from './prepare-release-plan.mjs';

const pkg = { name: 'valvejs', version: '0.4.0' };

test('plain 0.x and 1.x releases use npm’s default channel', () => {
  for (const version of ['0.4.0', '0.4.1', '0.5.0', '1.0.0']) {
    assert.equal(releaseTag({ ...pkg, version }), 'latest');
    assert.equal(
      releaseTag({ ...pkg, version, publishConfig: { tag: 'latest' } }),
      'latest',
    );
  }
});

test('release validation rejects suffixes, malformed versions, and custom channels', () => {
  for (const version of [
    '0.4.0-beta.0',
    '0.4.1-beta',
    '1.0.0-rc.1',
    '0.4.0+build.1',
    'v0.4.0',
    '0.4',
    '00.4.0',
  ]) {
    assert.throws(() => releaseTag({ ...pkg, version }), /plain x.y.z/);
  }
  for (const tag of ['beta', 'next']) {
    assert.throws(
      () => releaseTag({ ...pkg, publishConfig: { tag } }),
      /default npm channel/,
    );
  }
  assert.throws(() => releaseTag({ ...pkg, name: 'another-package' }));
});

test('leftover Changesets prerelease state cannot reach publishing', () => {
  for (const mode of ['pre', 'exit']) {
    assert.throws(
      () => releaseTag(pkg, { mode, tag: 'beta' }),
      /Finish exiting Changesets prerelease mode/,
    );
  }
});

test('packed plans use latest without changing versions, access, or nonpublish entries', () => {
  const release = {
    kind: 'publish',
    name: pkg.name,
    version: pkg.version,
    access: 'public',
    tag: 'beta',
  };
  const skip = { kind: 'none', name: 'private-workspace' };
  const plan = { version: 1, plan: [[release, skip]] };
  assert.deepEqual(prepareReleasePlan(plan, pkg).plan, [
    [{ ...release, tag: 'latest' }, skip],
  ]);
  assert.equal(plan.plan[0][0].tag, 'beta');
  for (const unexpected of [{ version: '0.3.0' }, { name: 'other' }]) {
    assert.throws(
      () =>
        prepareReleasePlan(
          { version: 1, plan: [[{ ...release, ...unexpected }]] },
          pkg,
        ),
      /Unexpected package/,
    );
  }
  assert.throws(() => prepareReleasePlan({ version: 2, plan: [] }, pkg));
  assert.throws(() => prepareReleasePlan({ version: 1, plan: [{}] }, pkg));
});
