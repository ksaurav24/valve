import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareReleasePlan, releaseTag } from './prepare-release-plan.mjs';

const beta = {
  name: 'valvejs',
  version: '0.3.0-beta.0',
  publishConfig: { tag: 'beta' },
};
const pre = { mode: 'pre', tag: 'beta' };

test('first and subsequent betas use the beta tag', () => {
  assert.equal(releaseTag(beta, pre), 'beta');
  assert.equal(releaseTag({ ...beta, version: '0.3.0-beta.1' }, pre), 'beta');
});

test('a beta cannot publish with stable or missing prerelease configuration', () => {
  assert.throws(() => releaseTag(beta));
  assert.throws(() => releaseTag(beta, { ...pre, mode: 'exit' }));
  assert.throws(() =>
    releaseTag({ ...beta, publishConfig: { tag: 'latest' } }, pre),
  );
  assert.throws(() => releaseTag({ ...beta, version: '0.3.0' }, pre));
});

test('stable releases work after exiting beta mode and removing the beta tag', () => {
  assert.equal(releaseTag({ name: 'valvejs', version: '0.3.0' }), 'latest');
  assert.throws(() => releaseTag({ ...beta, version: '0.3.0' }));
});

test('the packed plan corrects a beta marked latest without changing its version or access', () => {
  const release = {
    kind: 'publish',
    name: 'valvejs',
    version: beta.version,
    access: 'public',
    tag: 'latest',
  };
  const plan = { version: 1, plan: [[release]] };
  assert.deepEqual(prepareReleasePlan(plan, beta, pre).plan, [
    [{ ...release, tag: 'beta' }],
  ]);
  assert.equal(plan.plan[0][0].tag, 'latest');
  assert.throws(() =>
    prepareReleasePlan(
      { version: 1, plan: [[{ ...release, version: '0.2.0' }]] },
      beta,
      pre,
    ),
  );
  assert.throws(() => prepareReleasePlan({ version: 2, plan: [] }, beta, pre));
});
