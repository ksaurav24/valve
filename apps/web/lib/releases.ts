import changelog from '../.generated/changelog.json';
import metadata from '../.generated/metadata.json';
import { githubReleases } from './github';
import { site } from './site';
import { npmVersionState } from './release-state.mjs';

export interface ChangelogSection {
  title: string | null;
  items: string[];
}

export interface ChangelogEntry {
  version: string;
  sections: ChangelogSection[];
  sourceVersions?: string[];
}

export interface Release extends ChangelogEntry {
  publishedAt: string | null;
  npmUrl: string;
  githubUrl: string | null;
}

export type VersionState = 'latest' | 'published' | 'historical' | 'dev';

const npm = metadata.npm as {
  latest: string | null;
  versions: Record<string, string | null>;
};
export const changelogEntries = changelog as ChangelogEntry[];

function isPublished(version: string) {
  return Object.hasOwn(npm.versions, version);
}

function githubUrl(version: string) {
  const tags = [`v${version}`, `${site.packageName}@${version}`, version];
  return githubReleases.find((r) => tags.includes(r.tag))?.url ?? null;
}

/** Only versions npm lists are releases; everything else is development. */
export const releases: Release[] = changelogEntries
  .filter((entry) => isPublished(entry.version))
  .map((entry) => ({
    ...entry,
    publishedAt: npm.versions[entry.version] ?? null,
    npmUrl: `${site.npm}/v/${entry.version}`,
    githubUrl: githubUrl(entry.version),
  }));

export function versionState(version: string): VersionState {
  return npmVersionState(
    version,
    npm,
    changelogEntries.find((entry) => entry.version === version)?.sourceVersions,
  );
}

export const current = {
  version: site.version,
  state: versionState(site.version),
};
