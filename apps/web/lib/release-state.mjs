/**
 * @param {string} version
 * @param {{ latest: string | null, versions: Record<string, string | null> }} npm
 * @returns {'dev' | 'beta' | 'latest' | 'published'}
 */
export function npmVersionState(version, npm) {
  if (!Object.hasOwn(npm.versions, version)) return 'dev';
  // A registry's latest tag must never make a beta look stable.
  if (/-beta\.\d+$/.test(version)) return 'beta';
  return version === npm.latest ? 'latest' : 'published';
}
