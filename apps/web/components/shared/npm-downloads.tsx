'use client';

import useSWR from 'swr';
import { Download } from 'lucide-react';
import { NpmIcon } from '@/components/shared/icons';
import { downloadsEndpoint, parseDownloads } from '@/lib/npm-downloads.mjs';
import { site } from '@/lib/site';

const compact = new Intl.NumberFormat('en', { notation: 'compact' });

async function fetchDownloads(): Promise<number> {
  const response = await fetch(downloadsEndpoint);
  if (!response.ok) throw new Error(`npm answered ${response.status}`);
  return parseDownloads(await response.json());
}

export function NpmDownloads({ initial }: { initial: number | null }) {
  const { data } = useSWR(downloadsEndpoint, fetchDownloads, {
    fallbackData: initial ?? undefined,
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    dedupingInterval: 60 * 60 * 1000,
    shouldRetryOnError: false,
  });
  const downloads = data ?? initial;
  const label =
    downloads === null
      ? 'valvejs on npm, download count unavailable'
      : `valvejs on npm, ${downloads.toLocaleString('en')} downloads in the last 30 days`;

  return (
    <a
      href={site.npm}
      aria-label={label}
      title={label}
      className="group inline-flex h-8 shrink-0 items-center overflow-hidden rounded-md border border-border text-xs font-medium text-muted-foreground hover:border-ring hover:text-foreground"
    >
      <span className="flex h-full items-center px-2 sm:px-2.5">
        <NpmIcon className="h-2.5 w-7" />
      </span>
      <span className="flex h-full items-center gap-1 border-l border-border bg-muted/60 px-2 tabular-nums group-hover:bg-accent sm:px-2.5">
        <Download className="hidden size-3 sm:block" />
        {downloads === null ? '-' : compact.format(downloads)}
        <span className="hidden sm:inline">/mo</span>
      </span>
    </a>
  );
}
