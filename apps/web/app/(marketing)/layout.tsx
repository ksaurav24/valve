import Link from 'next/link';
import type { ReactNode } from 'react';
import { SiteNav } from '@/components/shared/site-nav';
import { navLinks } from '@/lib/nav';
import { stars } from '@/lib/github';
import { monthlyDownloads } from '@/lib/npm';
import { site } from '@/lib/site';

export default function MarketingLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
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
      <footer className="border-t border-border">
        <div className="mx-auto grid max-w-[90rem] gap-8 px-4 py-10 sm:px-6 md:grid-cols-[1fr_auto]">
          <div className="space-y-2">
            <p className="font-mono text-sm font-semibold">
              valve<span className="text-muted-foreground">_</span>
            </p>
            <p className="max-w-sm text-sm text-muted-foreground">
              One rate limit for every worker. Apache 2.0, built in the open.
            </p>
          </div>
          <nav
            aria-label="Footer"
            className="grid grid-cols-2 gap-x-10 gap-y-2 font-mono text-[13px] sm:grid-cols-3"
          >
            {navLinks.map(({ href, label }) => (
              <Link
                key={href}
                href={href}
                className="text-muted-foreground hover:text-foreground"
              >
                {label}
              </Link>
            ))}
            <a
              href={site.npm}
              className="text-muted-foreground hover:text-foreground"
            >
              npm
            </a>
            <a
              href="/api/index.html"
              className="text-muted-foreground hover:text-foreground"
            >
              typedoc
            </a>
            <a
              href={`${site.repository}/issues`}
              className="text-muted-foreground hover:text-foreground"
            >
              issues
            </a>
            <a
              href={`${site.source}/LICENSE`}
              className="text-muted-foreground hover:text-foreground"
            >
              license
            </a>
          </nav>
        </div>
        <div
          aria-hidden="true"
          className="pointer-events-none mx-auto max-w-[90rem] select-none overflow-hidden px-4 sm:px-6"
        >
          <p className="translate-y-[18%] bg-gradient-to-b from-foreground/15 to-transparent bg-clip-text font-mono text-[clamp(5rem,22vw,20rem)] font-bold leading-none tracking-tighter text-transparent">
            valve_
          </p>
        </div>
      </footer>
    </div>
  );
}
