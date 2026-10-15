import { mkdir, readFile, writeFile } from 'node:fs/promises';
import {
  mergeMetadata,
  parseContributors,
  parsePackument,
  parseReleases,
  parseRepo,
} from './merge-metadata.mjs';

// Fetches npm and GitHub data for the static build. Network and API failures
// never fail the build: each field falls back to the committed snapshot.
// Pass --write-snapshot to explicitly refresh the committed fallback snapshot.
const repo = 'ksaurav24/valve';
const pkg = 'valvejs';
const snapshotFile = new URL('../content/data/metadata.json', import.meta.url);
const outputFile = new URL('../.generated/metadata.json', import.meta.url);

const github = {
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  ...(process.env.GITHUB_TOKEN
    ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
    : {}),
};

/** Resolves to `{ ok, value }` or `{ ok: false, reason }`; never rejects. */
async function load(url, headers, parse, { notFound } = {}) {
  try {
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (response.status === 404 && notFound !== undefined)
      return { ok: true, value: parse(notFound) };
    if (response.status !== 200)
      return { ok: false, reason: `HTTP ${response.status}` };
    return { ok: true, value: parse(await response.json()) };
  } catch (error) {
    return { ok: false, reason: error?.message ?? String(error) };
  }
}

async function readSnapshot() {
  try {
    return JSON.parse(await readFile(snapshotFile, 'utf8'));
  } catch {
    return {};
  }
}

const api = `https://api.github.com/repos/${repo}`;
const [snapshot, npm, repository, contributors, releases] = await Promise.all([
  readSnapshot(),
  load(
    `https://registry.npmjs.org/${pkg.replace('/', '%2f')}`,
    { accept: 'application/json' },
    parsePackument,
    // npm answers 404 until the first publish: a valid "nothing published".
    { notFound: null },
  ),
  load(api, github, parseRepo),
  load(`${api}/contributors?per_page=100`, github, parseContributors),
  load(`${api}/releases?per_page=100`, github, parseReleases),
]);

const { data, status } = mergeMetadata(snapshot, {
  npm,
  repo: repository,
  contributors,
  releases,
});
for (const [field, state] of Object.entries(status))
  console.log(`metadata ${field}: ${state}`);

const json = JSON.stringify(data, null, 2) + '\n';
await mkdir(new URL('.', outputFile), { recursive: true });
await writeFile(outputFile, json);
if (process.argv.includes('--write-snapshot')) {
  await mkdir(new URL('.', snapshotFile), { recursive: true });
  await writeFile(snapshotFile, json);
}
