/**
 * @param {string} version
 * @param {{ latest: string | null, versions: Record<string, string | null> }} npm
 * @returns {'dev' | 'latest' | 'published'}
 */
export function npmVersionState(version, npm) {
  if (!Object.hasOwn(npm.versions, version)) return 'dev';
  return version === npm.latest ? 'latest' : 'published';
}

/** Beta describes API maturity, independently of publication or npm tags. */
export function isBetaVersion(version) {
  return version.startsWith('0.') || /-beta(?:\.|$)/.test(version);
}
