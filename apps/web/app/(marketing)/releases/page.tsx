import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowUpRight, Package } from 'lucide-react';
import { PageHeader } from '@/components/marketing/page-header';
import { ChangelogSections } from '@/components/marketing/changelog-entry';
import { GitHubIcon } from '@/components/shared/icons';
import { VersionBadge } from '@/components/shared/version-badge';
import { current, releases } from '@/lib/releases';

export const metadata: Metadata = {
  title: 'Releases',
  description: 'Published valve versions on npm, with their release notes.',
};

const date = new Intl.DateTimeFormat('en', { dateStyle: 'medium' });

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
      <div className="page-gutter py-16">
        {releases.length === 0 ? (
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
        ) : (
          <ol className="space-y-12">
            {releases.map((release) => (
              <li key={release.version} className="relative">
                <article
                  id={`v${release.version}`}
                  className="grid scroll-mt-24 gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] lg:gap-16"
                >
                  <header className="flex flex-col items-start gap-5">
                    <div className="flex flex-wrap items-center gap-3">
                      <h2 className="font-mono text-2xl font-medium">
                        v{release.version}
                      </h2>
                      <VersionBadge version={release.version} />
                      {release.publishedAt && (
                        <time
                          dateTime={release.publishedAt}
                          className="text-sm text-muted-foreground"
                        >
                          {date.format(new Date(release.publishedAt))}
                        </time>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-sm">
                      <ExternalLink href={release.npmUrl}>npm</ExternalLink>
                      {release.githubUrl && (
                        <ExternalLink href={release.githubUrl} github>
                          release
                        </ExternalLink>
                      )}
                    </div>
                  </header>
                  <div className="min-w-0 rounded-md bg-card p-6 sm:p-8">
                    <ChangelogSections sections={release.sections} />
                  </div>
                </article>
              </li>
            ))}
          </ol>
        )}
      </div>
    </>
  );
}

function ExternalLink({
  href,
  github,
  children,
}: {
  href: string;
  github?: boolean;
  children: string;
}) {
  return (
    <a
      href={href}
      className="group inline-flex min-h-11 items-center gap-1 rounded-md px-2 text-muted-foreground hover:bg-hover hover:text-foreground"
    >
      {github && <GitHubIcon className="size-3" />}
      {children}
      <ArrowUpRight className="size-3 transition-transform duration-150 group-hover:-translate-y-px group-hover:translate-x-px" />
    </a>
  );
}
