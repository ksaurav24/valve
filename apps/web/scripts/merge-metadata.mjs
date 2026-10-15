// Pure merge rules for website metadata. A fetch result is either
// `{ ok: true, value }` (a valid, successful answer) or `{ ok: false, reason }`.
// Failed or suspicious answers keep the snapshot, so a rate limit or outage
// never replaces valid cached data with zero or an empty list.

/** @returns {{ value: unknown, status: string }} */
function pick(fresh, cached, isEmpty) {
  if (!fresh.ok) return { value: cached, status: `cached (${fresh.reason})` };
  if (isEmpty(fresh.value) && !isEmpty(cached))
    return { value: cached, status: 'cached (empty answer)' };
  return { value: fresh.value, status: 'fresh' };
}

export const emptyMetadata = {
  npm: { latest: null, versions: {} },
  downloads: null,
  repo: { stars: 0, forks: 0 },
  contributors: [],
  releases: [],
};

/**
 * @param {typeof emptyMetadata} snapshot
 * @param {Record<keyof typeof emptyMetadata, { ok: boolean, value?: any, reason?: string }>} fresh
 */
export function mergeMetadata(snapshot, fresh) {
  const base = { ...emptyMetadata, ...snapshot };
  const fields = {
    npm: pick(
      fresh.npm,
      base.npm,
      (npm) => Object.keys(npm.versions).length === 0,
    ),
    // A rolling 30-day count may legitimately fall, including all the way to zero.
    downloads: pick(fresh.downloads, base.downloads, (count) => count === null),
    repo: pick(fresh.repo, base.repo, (repo) => repo.stars === 0),
    contributors: pick(
      fresh.contributors,
      base.contributors,
      (list) => list.length === 0,
    ),
    releases: pick(fresh.releases, base.releases, (list) => list.length === 0),
  };
  const data = Object.fromEntries(
    Object.entries(fields).map(([key, field]) => [key, field.value]),
  );
  const status = Object.fromEntries(
    Object.entries(fields).map(([key, field]) => [key, field.status]),
  );
  return { data, status };
}

/** Read the default npm channel and all versions, including historical prereleases. */
export function parsePackument(json) {
  if (json === null || json?.time?.unpublished)
    return { latest: null, versions: {} };
  if (typeof json !== 'object' || typeof json.versions !== 'object')
    throw new Error('malformed packument');
  const versions = {};
  for (const version of Object.keys(json.versions))
    versions[version] = json.time?.[version] ?? null;
  return {
    latest: json['dist-tags']?.latest ?? null,
    versions,
  };
}

export function parseRepo(json) {
  if (typeof json?.stargazers_count !== 'number')
    throw new Error('malformed repository');
  return { stars: json.stargazers_count, forks: json.forks_count ?? 0 };
}

export function parseContributors(json) {
  if (!Array.isArray(json)) throw new Error('malformed contributors');
  return json
    .filter((c) => c.type !== 'Bot' && !String(c.login).endsWith('[bot]'))
    .map((c) => ({
      login: String(c.login),
      avatar: String(c.avatar_url),
      url: String(c.html_url),
      contributions: Number(c.contributions) || 0,
    }));
}

export function parseReleases(json) {
  if (!Array.isArray(json)) throw new Error('malformed releases');
  return json
    .filter((r) => !r.draft)
    .map((r) => ({
      tag: String(r.tag_name),
      name: String(r.name || r.tag_name),
      url: String(r.html_url),
      publishedAt: r.published_at ?? null,
      prerelease: Boolean(r.prerelease),
    }));
}
