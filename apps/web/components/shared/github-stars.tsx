'use client';

import useSWR from 'swr';
import { Star } from 'lucide-react';
import { GitHubIcon } from '@/components/shared/icons';
import { site } from '@/lib/site';
import { cn } from '@/lib/utils';

const endpoint = `https://api.github.com/repos/${site.repo}`;
const cacheKey = 'valve:github-stars';
const ttl = 60 * 60 * 1000;

/** Unauthenticated public endpoint, cached in localStorage for an hour so
 * repeat visits stay well under GitHub's per-IP limit. */
async function fetchStars(): Promise<number> {
  try {
    const cached = JSON.parse(localStorage.getItem(cacheKey) ?? 'null');
    if (cached && Date.now() - cached.at < ttl && cached.stars > 0)
      return cached.stars;
  } catch {
    // Storage blocked or corrupt: fetch instead.
  }
  const response = await fetch(endpoint, {
    headers: { accept: 'application/vnd.github+json' },
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
  const stars = (await response.json())?.stargazers_count;
  if (typeof stars !== 'number') throw new Error('Unexpected GitHub response');
  try {
    localStorage.setItem(cacheKey, JSON.stringify({ stars, at: Date.now() }));
  } catch {
    // Storage blocked: the count still renders, uncached.
  }
  return stars;
}

const compact = new Intl.NumberFormat('en', { notation: 'compact' });

export function GitHubStars({
  initial,
  className,
}: {
  /** Build-time count; shown until (and if) the refresh succeeds. */
  initial: number;
  className?: string;
}) {
  const { data } = useSWR(endpoint, fetchStars, {
    fallbackData: initial,
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    dedupingInterval: ttl,
    shouldRetryOnError: false,
  });
  // A zero from a fresh repository never hides a known positive count.
  const stars = data > 0 ? data : initial;

  return (
    <a
      href={site.repository}
      className={cn(
        'group inline-flex h-8 items-center overflow-hidden rounded-md border border-border text-xs font-medium text-muted-foreground hover:border-ring hover:text-foreground',
        className,
      )}
      aria-label={`valve on GitHub, ${stars} stars`}
    >
      <span className="flex h-full items-center gap-1.5 px-2.5">
        <GitHubIcon className="size-3.5" />
        <span className="hidden sm:inline">GitHub</span>
      </span>
      <span className="flex h-full items-center gap-1 border-l border-border bg-muted/60 px-2.5 tabular-nums group-hover:bg-accent">
        <Star className="size-3 transition-transform duration-150 group-hover:scale-110 group-hover:fill-current" />
        {compact.format(stars)}
      </span>
    </a>
  );
}
