import type { ReactNode } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { ChangelogSections } from '@/components/marketing/changelog-entry';
import { VersionRail } from '@/components/marketing/version-rail';
import { CopyButton } from '@/components/shared/copy-button';
import { GitHubIcon } from '@/components/shared/icons';
import { isBetaVersion } from '@/lib/release-state.mjs';
import type { ChangelogSection, VersionState } from '@/lib/releases';
import { site } from '@/lib/site';
import { cn } from '@/lib/utils';

export interface LogEntry {
  id: string;
  version: string;
  state: VersionState;
  publishedAt: string | null;
  sections: ChangelogSection[];
  /** Preview builds grouped under this plain version. */
  sourceVersions?: string[];
  npmUrl?: string;
  githubUrl?: string | null;
}

const stateLabels: Record<VersionState, string> = {
  latest: 'latest',
  published: 'published',
  historical: 'historical notes',
  dev: 'unreleased',
};

const date = new Intl.DateTimeFormat('en', {
  dateStyle: 'medium',
  timeZone: 'UTC',
});

/** Shared timeline for /releases and /changelog, with a scroll-tracking index. */
export function ReleaseLog({
  entries,
  path,
  railLabel,
  railFooter,
}: {
  entries: LogEntry[];
  /** Page path, for permalinks. */
  path: string;
  railLabel: string;
  railFooter?: ReactNode;
}) {
  return (
    <div className="page-gutter py-14 sm:py-20">
      <div className="mx-auto grid max-w-6xl items-start gap-12 lg:grid-cols-[11rem_minmax(0,1fr)] lg:gap-16">
        <aside className="min-w-0 lg:sticky lg:top-24">
          <VersionRail
            label={railLabel}
            footer={railFooter}
            items={entries.map((entry) => ({
              id: entry.id,
              version: entry.version,
              latest: entry.state === 'latest',
              muted: entry.state === 'dev' || entry.state === 'historical',
            }))}
          />
        </aside>
        <ol className="release-log">
          {entries.map((entry) => (
            <li key={entry.id} className="release-entry">
              <span
                aria-hidden="true"
                className={cn(
                  'release-node',
                  entry.state === 'latest' && 'release-node-live',
                  (entry.state === 'dev' || entry.state === 'historical') &&
                    'release-node-muted',
                )}
              />
              <article id={entry.id} className="scroll-mt-24">
                <header className="group/header flex flex-wrap items-center gap-x-3 gap-y-2">
                  <h2 className="font-mono text-2xl font-medium tracking-tight sm:text-[1.75rem]">
                    <a
                      href={`#${entry.id}`}
                      className="hover:text-live-foreground"
                    >
                      v{entry.version}
                    </a>
                  </h2>
                  <StatePill version={entry.version} state={entry.state} />
                  {entry.publishedAt && (
                    <time
                      dateTime={entry.publishedAt}
                      className="text-sm text-muted-foreground"
                    >
                      {date.format(new Date(entry.publishedAt))}
                    </time>
                  )}
                  <CopyButton
                    value={`${site.url}${path}#${entry.id}`}
                    label={`Copy link to v${entry.version}`}
                    icon="link"
                    className="opacity-100 transition-opacity duration-150 lg:opacity-0 lg:group-hover/header:opacity-100 lg:focus-within:opacity-100"
                  />
                  {(entry.npmUrl || entry.githubUrl) && (
                    <div className="flex items-center gap-1 text-sm sm:ml-auto">
                      {entry.npmUrl && (
                        <ExternalLink href={entry.npmUrl}>npm</ExternalLink>
                      )}
                      {entry.githubUrl && (
                        <ExternalLink href={entry.githubUrl} github>
                          release
                        </ExternalLink>
                      )}
                    </div>
                  )}
                </header>
                {entry.sourceVersions?.length ? (
                  <p className="mt-2 font-mono text-xs text-muted-foreground">
                    Groups {entry.sourceVersions.join(', ')}
                  </p>
                ) : null}
                <div className="release-card mt-6">
                  <ChangelogSections sections={entry.sections} />
                </div>
              </article>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function StatePill({
  version,
  state,
}: {
  version: string;
  state: VersionState;
}) {
  return (
    <span
      className={cn(
        'inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs',
        state === 'latest'
          ? 'bg-live/12 text-live-foreground'
          : 'bg-muted text-muted-foreground',
      )}
    >
      {state === 'latest' && (
        <span aria-hidden="true" className="live-dot live-dot-sm" />
      )}
      {stateLabels[state]}
      {isBetaVersion(version) && state !== 'dev' && (
        <span className="opacity-70">· beta</span>
      )}
    </span>
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
