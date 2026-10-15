import release from '../.generated/release.json';

export const site = {
  name: 'valve',
  description:
    'A shared rate limit for outbound API calls across every worker, with provider-aware backoff.',
  /** From packages/valve/package.json, copied by scripts/sync-content.mjs. */
  version: release.version,
  packageName: 'valvejs',
  repo: 'ksaurav24/valve',
  repository: 'https://github.com/ksaurav24/valve',
  source: 'https://github.com/ksaurav24/valve/blob/master',
  npm: 'https://www.npmjs.com/package/valvejs',
};
