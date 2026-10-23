import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = new URL('../../../', import.meta.url);
const version = '0.6.0';
const publishedAt = '2026-10-22T14:07:32.648Z';
const published = {
  'dist-tags': { latest: version },
  versions: { [version]: {} },
  time: { [version]: publishedAt },
};
const stale = { 'dist-tags': { latest: '0.5.2' }, versions: { '0.5.2': {} } };

async function sync({ snapshot = {}, released = true, offline = false } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'valve-metadata-'));
  try {
    for (const file of [
      'apps/web/scripts/sync-metadata.mjs',
      'apps/web/scripts/merge-metadata.mjs',
      'apps/web/lib/npm-downloads.mjs',
      'scripts/wait-for-npm-release.mjs',
      'scripts/prepare-release-plan.mjs',
    ]) {
      await mkdir(join(cwd, file, '..'), { recursive: true });
      await cp(new URL(file, root), join(cwd, file));
    }
    await mkdir(join(cwd, 'packages/valve'), { recursive: true });
    await writeFile(
      join(cwd, 'packages/valve/package.json'),
      JSON.stringify({ name: 'valvejs', version }),
    );
    await mkdir(join(cwd, 'apps/web/content/data'), { recursive: true });
    await writeFile(
      join(cwd, 'apps/web/content/data/metadata.json'),
      JSON.stringify(snapshot),
    );
    const script = pathToFileURL(
      join(cwd, 'apps/web/scripts/sync-metadata.mjs'),
    );
    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `let npmRequests = 0;
        globalThis.fetch = async (url) => {
          if (${offline}) throw new Error('offline');
          let data;
          if (url.startsWith('https://registry.npmjs.org/')) {
            data = ++npmRequests === 1 ? ${JSON.stringify(stale)} : ${JSON.stringify(published)};
          } else if (url.includes('/releases?')) {
            data = ${JSON.stringify(released ? [{ tag_name: `valvejs@${version}`, html_url: 'https://example.com/release', published_at: publishedAt }] : [])};
          } else if (url.includes('/contributors?')) {
            data = [];
          } else if (url.startsWith('https://api.npmjs.org/')) {
            data = {package: 'valvejs', downloads: 10};
          } else {
            data = {stargazers_count: 3};
          }
          return {ok: true, status: 200, json: async () => data};
        };
        await import(${JSON.stringify(script.href)});
        console.log('npm requests: ' + npmRequests);`,
      ],
      { cwd, encoding: 'utf8', timeout: 5000 },
    );
    return {
      output,
      metadata: JSON.parse(
        await readFile(join(cwd, 'apps/web/.generated/metadata.json'), 'utf8'),
      ),
    };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test('a known GitHub release retries stale npm data before generating the website', async () => {
  const { metadata, output } = await sync();
  assert.equal(metadata.npm.latest, version);
  assert.equal(metadata.npm.versions[version], publishedAt);
  assert.match(output, /npm requests: 2/);
});

test('a stale npm response cannot erase the published version in the snapshot', async () => {
  const npm = { latest: version, versions: { [version]: publishedAt } };
  const { metadata, output } = await sync({
    snapshot: { npm },
    released: false,
  });
  assert.deepEqual(metadata.npm, npm);
  assert.match(output, /metadata npm: cached/);
  assert.match(output, /npm requests: 1/);
});

test('offline builds retain the published snapshot', async () => {
  const npm = { latest: version, versions: { [version]: publishedAt } };
  const { metadata } = await sync({ snapshot: { npm }, offline: true });
  assert.deepEqual(metadata.npm, npm);
});

test('a development version without a release does not wait for publication', async () => {
  const { metadata, output } = await sync({ released: false });
  assert.equal(Object.hasOwn(metadata.npm.versions, version), false);
  assert.match(output, /npm requests: 1/);
});
