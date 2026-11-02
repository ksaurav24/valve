import release from '../.generated/release.json';

const packageName = 'valvejs';

export const site = {
  name: 'valve',
  // Use the production origin for metadata, including on preview deployments.
  url: new URL(process.env.NEXT_PUBLIC_SITE_URL || 'https://valvejs.vercel.app')
    .origin,
  title: 'valve: Rate limiting for outbound APIs',
  description:
    'Queue outbound API requests with shared rate limits, concurrency controls, and provider backoff. Built for TypeScript, with memory, Redis, and Valkey stores.',
  /** From packages/valve/package.json, copied by scripts/sync-content.mjs. */
  version: release.version,
  packageName,
  installPackage: packageName,
  repo: 'ksaurav24/valve',
  repository: 'https://github.com/ksaurav24/valve',
  source: 'https://github.com/ksaurav24/valve/blob/master',
  npm: 'https://www.npmjs.com/package/valvejs',
};
