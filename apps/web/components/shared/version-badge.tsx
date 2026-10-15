import Link from 'next/link';
import { current, versionState, type VersionState } from '@/lib/releases';
import { cn } from '@/lib/utils';
import { isBetaVersion } from '@/lib/release-state.mjs';

const labels: Record<VersionState, string> = {
  latest: 'latest',
  published: 'published',
  historical: 'historical notes',
  dev: 'dev · unreleased',
};

/** Version from packages/valve/package.json; "latest" only when npm says so. */
export function VersionBadge({
  version = current.version,
  className,
}: {
  version?: string;
  className?: string;
}) {
  const state = versionState(version);
  const beta = isBetaVersion(version);
  return (
    <Link
      href={
        state === 'dev' || state === 'historical' ? '/changelog' : '/releases'
      }
      className={cn(
        'inline-flex h-7 items-center gap-2 rounded-full border border-border bg-card px-3 font-mono text-xs text-muted-foreground hover:border-ring hover:text-foreground',
        className,
      )}
      title={
        (state === 'historical'
          ? 'Historical preview notes grouped under a plain version heading'
          : state === 'dev'
            ? 'Development version: not published to npm yet'
            : 'Published on npm') +
        (beta ? '. Beta: APIs may change before 1.0.' : '')
      }
    >
      <span
        aria-hidden="true"
        className={cn(
          'size-1.5 rounded-full',
          state === 'dev' ? 'bg-muted-foreground/60' : 'bg-live',
        )}
      />
      <span className="text-foreground">v{version}</span>
      <span>{labels[state]}</span>
      {beta && <span>· beta</span>}
    </Link>
  );
}
