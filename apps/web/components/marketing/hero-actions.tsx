'use client';

import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { GitHubIcon } from '@/components/shared/icons';
import { Button } from '@/components/ui/button';
import { site } from '@/lib/site';

export function HeroActions() {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button asChild variant="primary" trailingIcon={ArrowRight}>
        <Link href="/docs/quickstart">Get started</Link>
      </Button>
      <Button asChild variant="secondary" leadingIcon={GitHubIcon}>
        <a href={site.repository}>Source</a>
      </Button>
    </div>
  );
}
