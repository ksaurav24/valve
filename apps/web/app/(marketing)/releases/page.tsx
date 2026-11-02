import type { Metadata } from 'next';
import Link from 'next/link';
import { Package } from 'lucide-react';
import { PageHeader } from '@/components/marketing/page-header';
import { ReleaseLog } from '@/components/marketing/release-log';
import { VersionBadge } from '@/components/shared/version-badge';
import { current, releases, versionState } from '@/lib/releases';
import { pageMetadata } from '@/lib/metadata';

export const metadata: Metadata = pageMetadata({
  title: 'Releases',
  description: 'Published valve versions on npm, with their release notes.',
  path: '/releases',
});

export default function ReleasesPage() {
  return (
    <>
      <PageHeader eyebrow="releases" title="Releases" aside={<VersionBadge />}>
        <p>
          Plain versions published to npm, newest first. Release notes come from
          the package changelog; development versions stay on the{' '}
          <Link
            href="/changelog"
            className="text-foreground underline decoration-ring underline-offset-4 hover:decoration-foreground"
          >
            changelog
          </Link>
          .
        </p>
      </PageHeader>
      {releases.length === 0 ? (
        <div className="page-gutter py-16">
          <div className="rounded-md bg-card px-6 py-16 text-center">
            <Package className="mx-auto size-6 text-muted-foreground" />
            <h2 className="mt-4 text-lg font-medium">
              No plain-version releases yet
            </h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
              The current development version is{' '}
              <span className="font-mono text-foreground">
                v{current.version}
              </span>
              . It will appear here after npm lists it. Historical prerelease
              versions are omitted from this list.
            </p>
            <Link
              href="/changelog"
              className="mt-6 inline-flex h-9 items-center rounded-md border border-border px-4 font-mono text-xs hover:border-ring hover:bg-accent"
            >
              Read the changelog
            </Link>
          </div>
        </div>
      ) : (
        <ReleaseLog
          path="/releases/"
          railLabel="Releases"
          railFooter={
            <Link
              href="/changelog"
              className="inline-flex min-h-9 items-center text-muted-foreground hover:text-foreground"
            >
              Full changelog
            </Link>
          }
          entries={releases.map((release) => ({
            id: `v${release.version}`,
            version: release.version,
            state: versionState(release.version),
            publishedAt: release.publishedAt,
            sections: release.sections,
            npmUrl: release.npmUrl,
            githubUrl: release.githubUrl,
          }))}
        />
      )}
    </>
  );
}
