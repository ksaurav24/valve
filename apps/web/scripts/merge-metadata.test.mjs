import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDownloads } from '../lib/npm-downloads.mjs';
import {
  mergeMetadata,
  parseContributors,
  parsePackument,
} from './merge-metadata.mjs';

const snapshot = {
  npm: {
    latest: '1.0.0',
    versions: { '1.0.0': '2026-01-01T00:00:00Z' },
  },
  downloads: 42,
  repo: { stars: 42, forks: 3 },
  contributors: [{ login: 'a', avatar: '', url: '', contributions: 5 }],
  releases: [{ tag: 'v1.0.0', name: 'v1.0.0', url: '', publishedAt: null }],
};
const failed = { ok: false, reason: 'HTTP 403' };

test('download counts accept zero and reject malformed or unrelated data', () => {
  assert.equal(parseDownloads({ package: 'valvejs', downloads: 0 }), 0);
  assert.equal(parseDownloads({ package: 'valvejs', downloads: 1234 }), 1234);
  for (const json of [
    null,
    {},
    { error: 'not found' },
    { package: 'another-package', downloads: 10 },
    { package: 'valvejs', downloads: -1 },
    { package: 'valvejs', downloads: 1.5 },
    { package: 'valvejs', downloads: '10' },
  ])
    assert.throws(() => parseDownloads(json));
});

test('a rolling download count can decrease to zero; outages keep the snapshot', () => {
  const fresh = {
    npm: failed,
    repo: failed,
    contributors: failed,
    releases: failed,
  };
  const { data, status } = mergeMetadata(snapshot, {
    ...fresh,
    downloads: { ok: true, value: 0 },
  });
  assert.equal(data.downloads, 0);
  assert.equal(status.downloads, 'fresh');
  assert.equal(
    mergeMetadata(snapshot, { ...fresh, downloads: failed }).data.downloads,
    42,
  );
  assert.equal(
    mergeMetadata({}, { ...fresh, downloads: failed }).data.downloads,
    null,
  );
});

test('failed fetches keep every snapshot field', () => {
  const { data, status } = mergeMetadata(snapshot, {
    npm: failed,
    downloads: failed,
    repo: failed,
    contributors: failed,
    releases: failed,
  });
  assert.deepEqual(data, snapshot);
  assert.equal(status.repo, 'cached (HTTP 403)');
});

test('zero stars or empty lists never replace cached data', () => {
  const { data } = mergeMetadata(snapshot, {
    npm: { ok: true, value: parsePackument(null) },
    downloads: failed,
    repo: { ok: true, value: { stars: 0, forks: 0 } },
    contributors: { ok: true, value: [] },
    releases: { ok: true, value: [] },
  });
  assert.deepEqual(data, snapshot);
});

test('fresh answers replace the snapshot', () => {
  const { data, status } = mergeMetadata(snapshot, {
    npm: failed,
    downloads: failed,
    repo: { ok: true, value: { stars: 43, forks: 3 } },
    contributors: failed,
    releases: failed,
  });
  assert.equal(data.repo.stars, 43);
  assert.equal(status.repo, 'fresh');
});

test('an npm 404 with no snapshot means nothing is published', () => {
  const { data } = mergeMetadata(
    {},
    {
      npm: { ok: true, value: parsePackument(null) },
      downloads: failed,
      repo: failed,
      contributors: failed,
      releases: failed,
    },
  );
  assert.deepEqual(data.npm, { latest: null, versions: {} });
  assert.equal(data.repo.stars, 0);
});

test('packuments map versions to publish times', () => {
  assert.deepEqual(
    parsePackument({
      'dist-tags': { latest: '1.0.0' },
      versions: { '1.0.0': {} },
      time: { '1.0.0': '2026-01-01T00:00:00Z', created: 'x' },
    }),
    {
      latest: '1.0.0',
      versions: { '1.0.0': '2026-01-01T00:00:00Z' },
    },
  );
  assert.throws(() => parsePackument({ error: 'x' }));
});

test('bots are not listed as contributors', () => {
  assert.deepEqual(
    parseContributors([
      { login: 'dependabot[bot]', type: 'Bot', contributions: 9 },
      {
        login: 'me',
        type: 'User',
        avatar_url: 'a',
        html_url: 'u',
        contributions: 2,
      },
    ]).map((c) => c.login),
    ['me'],
  );
});

test('only the default channel selects latest; historical prereleases remain available', () => {
  const parsed = parsePackument({
    'dist-tags': { latest: '0.4.0', beta: '0.4.0-beta.0' },
    versions: { '0.4.0': {}, '0.4.0-beta.0': {} },
  });
  assert.equal(parsed.latest, '0.4.0');
  assert.equal(Object.hasOwn(parsed, 'beta'), false);
  assert.ok(Object.hasOwn(parsed.versions, '0.4.0-beta.0'));
  assert.equal(
    parsePackument({
      'dist-tags': { beta: '0.4.0-beta.0' },
      versions: { '0.4.0-beta.0': {} },
    }).latest,
    null,
  );
});

test('an npm tombstone is treated as unpublished', () => {
  assert.deepEqual(
    parsePackument({
      time: { unpublished: { time: '2025-02-22T16:04:28.026Z' } },
    }),
    {
      latest: null,
      versions: {},
    },
  );
});
