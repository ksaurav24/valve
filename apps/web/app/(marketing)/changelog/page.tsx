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
import { changelogSource } from '@/lib/source';

export const metadata: Metadata = pageMetadata({
  title: 'Changelog',
  description: 'Release notes and unreleased changes for valve.',
  path: '/changelog',
});

export default function ChangelogPage() {
  const page = changelogSource.getPage([]);
  if (!page) throw new Error('Run the content sync before building the site.');
  // Reuse MDX's IDs so punctuation and duplicate-heading suffixes stay compatible.
  const headingText = new Map(
    page.data.structuredData.headings.map(({ id, content }) => [
      `#${id}`,
      content,
    ]),
  );
  const sectionAnchors = new Map<string, string[]>();
  let version = '';
  for (const heading of page.data.toc) {
    const title = headingText.get(heading.url);
    if (title === undefined) continue;
    if (heading.depth === 2) version = title;
    else if (heading.depth === 3) {
      const key = `${version}:${title}`;
      sectionAnchors.set(key, [
        ...(sectionAnchors.get(key) ?? []),
        heading.url.slice(1),
      ]);
    }
  }
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
          sections: entry.sections.map((section) => ({
            ...section,
            anchors: sectionAnchors.get(`${entry.version}:${section.title}`),
          })),
          ...(entry.sourceVersions
            ? { sourceVersions: entry.sourceVersions }
            : {}),
        }))}
      />
    </>
  );
}
