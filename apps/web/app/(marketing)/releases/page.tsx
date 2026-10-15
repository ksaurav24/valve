import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowUpRight, Package } from 'lucide-react';
import { PageHeader } from '@/components/marketing/page-header';
import { ChangelogSections } from '@/components/marketing/changelog-entry';
import { GitHubIcon } from '@/components/shared/icons';
import { VersionBadge } from '@/components/shared/version-badge';
import { current, latestPublished, releases } from '@/lib/releases';

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
          Versions published to npm, newest first. Release notes come from the
          package changelog; development versions stay on the{' '}
          <Link
            href="/changelog"
            className="text-foreground underline decoration-ring underline-offset-4 hover:decoration-foreground"
          >
            changelog
          </Link>
          .
        </p>
      </PageHeader>
      <div className="mx-auto max-w-5xl px-4 py-12 sm:px-6">
        {releases.length === 0 ? (
          <div className="bg-dots rounded-2xl border border-dashed border-border px-6 py-16 text-center">
            <Package className="mx-auto size-6 text-muted-foreground" />
            <h2 className="mt-4 text-lg font-medium">
              No published releases yet
            </h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
              The current development version is{' '}
              <span className="font-mono text-foreground">
                v{current.version}
              </span>
              . The first public release is planned for the v0.3.0 beta series.
            </p>
            <Link
              href="/changelog"
              className="mt-6 inline-flex h-9 items-center rounded-md border border-border px-4 font-mono text-xs hover:border-ring hover:bg-accent"
            >
              Read the changelog
            </Link>
          </div>
        ) : (
          <ol className="relative space-y-10 border-l border-border pl-6 sm:pl-10">
            {releases.map((release) => (
              <li key={release.version} className="relative">
                <span
                  aria-hidden="true"
                  className={`absolute -left-[29px] top-2 size-2.5 rounded-full border-2 border-background sm:-left-[45px] ${
                    release.version === latestPublished
                      ? 'bg-live'
                      : 'bg-muted-foreground/50'
                  }`}
                />
                <article
                  id={`v${release.version}`}
                  className="scroll-mt-20 rounded-xl border border-border bg-card"
                >
                  <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
                    <div className="flex flex-wrap items-center gap-3">
                      <h2 className="font-mono text-lg font-semibold">
                        v{release.version}
                      </h2>
                      <VersionBadge version={release.version} />
                      {release.publishedAt && (
                        <time
                          dateTime={release.publishedAt}
                          className="text-xs text-muted-foreground"
                        >
                          {date.format(new Date(release.publishedAt))}
                        </time>
                      )}
                    </div>
                    <div className="flex items-center gap-1 font-mono text-xs">
                      <ExternalLink href={release.npmUrl}>npm</ExternalLink>
                      {release.githubUrl && (
                        <ExternalLink href={release.githubUrl} github>
                          release
                        </ExternalLink>
                      )}
                    </div>
                  </header>
                  <div className="px-5 py-5">
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
      className="group inline-flex h-7 items-center gap-1 rounded-md px-2 text-muted-foreground hover:bg-hover hover:text-foreground"
    >
      {github && <GitHubIcon className="size-3" />}
      {children}
      <ArrowUpRight className="size-3 transition-transform duration-150 group-hover:-translate-y-px group-hover:translate-x-px" />
    </a>
  );
}
