import assert from 'node:assert/strict';
import test from 'node:test';
import { isBetaVersion, npmVersionState } from '../lib/release-state.mjs';

test('a prepared plain version stays development until npm lists it', () => {
  assert.equal(npmVersionState('0.4.0', { latest: null, versions: {} }), 'dev');
  assert.equal(isBetaVersion('0.4.0'), true);
});

test('latest and older 0.x releases are published and independently beta', () => {
  const npm = { latest: '0.4.0', versions: { '0.3.0': null, '0.4.0': null } };
  assert.equal(npmVersionState('0.4.0', npm), 'latest');
  assert.equal(npmVersionState('0.3.0', npm), 'published');
  assert.equal(isBetaVersion('0.4.0'), true);
  assert.equal(isBetaVersion('0.3.0'), true);
});

test('historical prereleases retain their identity without selecting an install channel', () => {
  const version = '0.4.0-beta.0';
  const versions = { [version]: null };
  assert.equal(
    npmVersionState(version, { latest: null, versions }),
    'published',
  );
  assert.equal(
    npmVersionState(version, { latest: version, versions }),
    'latest',
  );
  assert.equal(isBetaVersion(version), true);
});

test('the maturity label ends at 1.0, independently of latest', () => {
  const npm = { latest: '1.0.0', versions: { '1.0.0': null, '1.1.0': null } };
  assert.equal(isBetaVersion('1.0.0'), false);
  assert.equal(isBetaVersion('1.1.0'), false);
  assert.equal(npmVersionState('1.0.0', npm), 'latest');
  assert.equal(npmVersionState('1.1.0', npm), 'published');
});

test('grouped preview notes never masquerade as a plain npm release or new development', () => {
  const npm = {
    latest: '0.4.0',
    versions: { '0.4.0': null, '0.3.0-beta.0': null },
  };
  assert.equal(npmVersionState('0.3.0', npm, ['0.3.0-beta.0']), 'historical');
  assert.equal(npmVersionState('0.4.1', npm), 'dev');
  assert.equal(npmVersionState('0.4.0', npm), 'latest');
});
