import Link from 'next/link';
import type { ReactNode } from 'react';
import { SiteNav } from '@/components/shared/site-nav';
import { navLinks } from '@/lib/nav';
import { stars } from '@/lib/github';
import { monthlyDownloads } from '@/lib/npm';
import { site } from '@/lib/site';

export default function MarketingLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#main-content"
        className="sr-only z-50 rounded-md bg-foreground px-3 py-2 text-background focus:not-sr-only focus:fixed focus:left-4 focus:top-3"
      >
        Skip to content
      </a>
      <SiteNav stars={stars} downloads={monthlyDownloads} />
      <main id="main-content" tabIndex={-1} className="flex-1 outline-none">
        {children}
      </main>
      <footer className="page-gutter py-10 sm:py-14">
        <div className="flex flex-col justify-between gap-8 lg:flex-row lg:items-start">
          <div className="space-y-3">
            <Link
              href="/"
              className="inline-block font-mono text-2xl font-semibold tracking-tight"
            >
              valve_
            </Link>
            <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">
              One rate limit for every worker.
              <br />
              Apache 2.0, built in the open.
            </p>
          </div>
          <nav
            aria-label="Footer"
            className="flex max-w-2xl flex-wrap gap-x-6 gap-y-1 text-sm"
          >
            {navLinks.map(({ href, label }) => (
              <Link
                key={href}
                href={href}
                className="inline-flex min-h-11 items-center text-muted-foreground hover:text-foreground"
              >
                {label}
              </Link>
            ))}
            <a
              href={site.npm}
              className="inline-flex min-h-11 items-center text-muted-foreground hover:text-foreground"
            >
              npm
            </a>
            <a
              href="/api/index.html"
              className="inline-flex min-h-11 items-center text-muted-foreground hover:text-foreground"
            >
              API reference
            </a>
            <a
              href={`${site.repository}/issues`}
              className="inline-flex min-h-11 items-center text-muted-foreground hover:text-foreground"
            >
              issues
            </a>
            <a
              href={`${site.source}/LICENSE`}
              className="inline-flex min-h-11 items-center text-muted-foreground hover:text-foreground"
            >
              license
            </a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
