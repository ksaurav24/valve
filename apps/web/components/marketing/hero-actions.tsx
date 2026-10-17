'use client';

import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { site } from '@/lib/site';

export function HeroActions() {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Link href="/docs/quickstart" className="primary-doc-link">
        Read quickstart <ArrowRight aria-hidden="true" className="size-4" />
      </Link>
      <a
        href={site.repository}
        className="inline-flex min-h-11 items-center px-3 text-sm text-muted-foreground hover:text-foreground"
      >
        View source
      </a>
    </div>
  );
}
