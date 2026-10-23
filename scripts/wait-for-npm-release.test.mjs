import assert from 'node:assert/strict';
import test from 'node:test';
import { waitForNpmRelease } from './wait-for-npm-release.mjs';

const pkg = { name: 'valvejs', version: '0.6.0' };
const ready = {
  'dist-tags': { latest: pkg.version },
  versions: { [pkg.version]: {} },
  time: { [pkg.version]: '2026-10-22T14:07:32.648Z' },
};
const response = (json) => ({ ok: true, json: async () => json });

function registry(answers, options = {}) {
  let requests = 0;
  const sleeps = [];
  return {
    get requests() {
      return requests;
    },
    sleeps,
    wait: () =>
      waitForNpmRelease(pkg, {
        tag: 'latest',
        attempts: answers.length,
        fetchImpl: async (url, init) => {
          assert.equal(url, 'https://registry.npmjs.org/valvejs');
          assert.equal(init.headers.accept, 'application/json');
          assert.equal(init.headers['cache-control'], 'no-cache');
          assert.ok(init.signal instanceof AbortSignal);
          const answer = answers[requests++];
          if (answer instanceof Error) throw answer;
          return answer;
        },
        sleep: async (ms) => sleeps.push(ms),
        log: () => {},
        ...options,
      }),
  };
}

test('an already visible release proceeds without waiting', async () => {
  const npm = registry([response(ready)]);
  assert.deepEqual(await npm.wait(), ready);
  assert.equal(npm.requests, 1);
  assert.deepEqual(npm.sleeps, []);
});

test('waits for version, publication time, and latest tag to propagate', async () => {
  const npm = registry([
    response({ versions: { '0.5.2': {} }, 'dist-tags': { latest: '0.5.2' } }),
    response({ ...ready, 'dist-tags': { latest: '0.5.2' } }),
    response({ ...ready, time: {} }),
    response({ ...ready, time: { [pkg.version]: 'invalid' } }),
    response(ready),
  ]);
  assert.deepEqual(await npm.wait(), ready);
  assert.equal(npm.requests, 5);
  assert.deepEqual(npm.sleeps, [10_000, 10_000, 10_000, 10_000]);
});

test('retries registry errors, timeouts, and malformed responses', async () => {
  const npm = registry([
    { ok: false, status: 404 },
    { ok: false, status: 429 },
    { ok: false, status: 503 },
    new Error('request timed out'),
    { ok: true, json: async () => JSON.parse('invalid') },
    response(null),
    response(ready),
  ]);
  assert.deepEqual(await npm.wait(), ready);
  assert.equal(npm.requests, 7);
});

test('fails when the release never appears instead of allowing a stale rebuild', async () => {
  const npm = registry([
    response({ versions: {} }),
    response({ versions: {} }),
  ]);
  await assert.rejects(npm.wait(), /npm did not expose valvejs@0\.6\.0/);
  assert.equal(npm.requests, 2);
  assert.deepEqual(npm.sleeps, [10_000]);
});

test('fails with the registry error when retries are exhausted', async () => {
  const npm = registry([{ ok: false, status: 503 }]);
  await assert.rejects(npm.wait(), /HTTP 503/);
  assert.deepEqual(npm.sleeps, []);
});

test('a website build can wait for an older published version without changing latest', async () => {
  const older = { ...ready, 'dist-tags': { latest: '0.7.0' } };
  const npm = registry([response(older)], { tag: undefined });
  assert.deepEqual(await npm.wait(), older);
});

test('an unpublished package is not considered a visible release', async () => {
  const npm = registry([
    response({ ...ready, time: { ...ready.time, unpublished: {} } }),
    response(ready),
  ]);
  assert.deepEqual(await npm.wait(), ready);
  assert.equal(npm.requests, 2);
});
