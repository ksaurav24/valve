import metadata from '../.generated/metadata.json';

export interface Contributor {
  login: string;
  avatar: string;
  url: string;
  contributions: number;
}

export interface GitHubRelease {
  tag: string;
  name: string;
  url: string;
  publishedAt: string | null;
  prerelease: boolean;
}

/** Build-time values from scripts/sync-metadata.mjs, with snapshot fallback. */
export const stars: number = metadata.repo.stars;
export const contributors = metadata.contributors as Contributor[];
export const githubReleases = metadata.releases as GitHubRelease[];
