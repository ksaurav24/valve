import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHeader } from '@/components/marketing/page-header';
import { ReleaseLog } from '@/components/marketing/release-log';
import { VersionBadge } from '@/components/shared/version-badge';
import {
  changelogAnchor,
  changelogEntries,
  releases,
  versionState,
} from '@/lib/releases';
import { site } from '@/lib/site';
import { pageMetadata } from '@/lib/metadata';

export const metadata: Metadata = pageMetadata({
  title: 'Changelog',
  description: 'Release notes and unreleased changes for valve.',
  path: '/changelog',
});

export default function ChangelogPage() {
  return (
    <>
      <PageHeader
        eyebrow="changelog"
        title="Changelog"
        aside={<VersionBadge />}
      >
        <p>
          Release notes and unreleased changes. The{' '}
          <a
            className="text-foreground underline decoration-ring underline-offset-4 hover:decoration-foreground"
            href={`${site.source}/packages/valve/CHANGELOG.md`}
          >
            full changelog
          </a>{' '}
          includes the original preview builds. Entries marked unreleased are
          not yet available on npm; historical notes collect earlier preview
          releases.
        </p>
      </PageHeader>
      <ReleaseLog
        path="/changelog/"
        railLabel="Versions"
        railFooter={
          <Link
            href="/releases"
            className="inline-flex min-h-9 items-center text-muted-foreground hover:text-foreground"
          >
            Published releases
          </Link>
        }
        entries={changelogEntries.map((entry) => ({
          id: changelogAnchor(entry.version),
          version: entry.version,
          state: versionState(entry.version),
          publishedAt:
            releases.find((release) => release.version === entry.version)
              ?.publishedAt ?? null,
          sections: entry.sections,
          ...(entry.sourceVersions
            ? { sourceVersions: entry.sourceVersions }
            : {}),
        }))}
      />
    </>
  );
}
