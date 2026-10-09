import Link from 'next/link';
import type { ReactNode } from 'react';
import { SiteNav } from '@/components/site-nav';
import { site } from '@/lib/site';
import './site.css';

export default function SiteLayout({ children }: { children: ReactNode }) {
  return (
    <div className="site-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <SiteNav repository={site.repository} />
      <main id="main-content" tabIndex={-1}>
        {children}
      </main>
      <footer className="site-footer">
        <div>
          <Link href="/" className="wordmark">
            valve
          </Link>
          <p>One rate limit for every worker.</p>
        </div>
        <nav aria-label="Project resources">
          <Link href="/docs/quickstart">Quickstart</Link>
          <a href={`${site.source}/CONTRIBUTING.md`}>Contributing</a>
          <a href={`${site.repository}/issues`}>Issues</a>
          <a href={`${site.source}/LICENSE`}>Apache 2.0</a>
        </nav>
      </footer>
    </div>
  );
}
