import assert from 'node:assert/strict';
import test from 'node:test';
import { npmVersionState } from '../lib/release-state.mjs';

test('an unpublished beta remains development until npm lists it', () => {
  assert.equal(
    npmVersionState('0.3.0-beta.0', { latest: null, versions: {} }),
    'dev',
  );
});

test('published betas are labeled beta even if latest points at one', () => {
  const version = '0.3.0-beta.0';
  const versions = { [version]: '2026-10-15T00:00:00Z' };
  assert.equal(npmVersionState(version, { latest: null, versions }), 'beta');
  assert.equal(npmVersionState(version, { latest: version, versions }), 'beta');
});

test('stable latest and older releases retain their labels', () => {
  const npm = { latest: '0.3.0', versions: { '0.2.0': null, '0.3.0': null } };
  assert.equal(npmVersionState('0.3.0', npm), 'latest');
  assert.equal(npmVersionState('0.2.0', npm), 'published');
});
