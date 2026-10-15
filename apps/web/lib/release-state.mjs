/**
 * @param {string} version
 * @param {{ latest: string | null, versions: Record<string, string | null> }} npm
 * @param {string[] | undefined} sourceVersions
 * @returns {'dev' | 'latest' | 'published' | 'historical'}
 */
export function npmVersionState(version, npm, sourceVersions) {
  if (!Object.hasOwn(npm.versions, version))
    return sourceVersions?.length ? 'historical' : 'dev';
  return version === npm.latest ? 'latest' : 'published';
}

/** Beta describes API maturity, independently of publication or npm tags. */
export function isBetaVersion(version) {
  return version.startsWith('0.') || /-beta(?:\.|$)/.test(version);
}
