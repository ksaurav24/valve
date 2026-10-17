import release from '../.generated/release.json';

const packageName = 'valvejs';

export const site = {
  name: 'valve',
  // Use the production origin for metadata, including on preview deployments.
  url: new URL(process.env.NEXT_PUBLIC_SITE_URL || 'https://valvejs.vercel.app')
    .origin,
  title: 'valve: Shared rate limits for outbound API calls',
  description:
    'A TypeScript library for outbound API rate limits, atomic shared and scoped budgets, and provider backoff. Memory, Redis, and Valkey stores with zero runtime dependencies.',
  /** From packages/valve/package.json, copied by scripts/sync-content.mjs. */
  version: release.version,
  packageName,
  installPackage: packageName,
  repo: 'ksaurav24/valve',
  repository: 'https://github.com/ksaurav24/valve',
  source: 'https://github.com/ksaurav24/valve/blob/master',
  npm: 'https://www.npmjs.com/package/valvejs',
};
