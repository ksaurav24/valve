'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { AnimatedThemeToggler } from '@/components/magicui/animated-theme-toggler';

const links = [
  { href: '/docs', label: 'Docs' },
  { href: '/changelog', label: 'Changelog' },
];

export function SiteNav({ repository }: { repository: string }) {
  const pathname = usePathname();

  return (
    <header className="site-header">
      <Link href="/" className="site-brand" aria-label="valve home">
        <span>valve</span>
      </Link>
      <nav aria-label="Main navigation" className="site-nav">
        {links.map(({ href, label }) => (
          <Link
            key={href}
            href={href}
            aria-current={pathname.startsWith(href) ? 'page' : undefined}
          >
            {label}
          </Link>
        ))}
        <a href={repository} className="github-link">
          GitHub
        </a>
      </nav>
      <AnimatedThemeToggler />
    </header>
  );
}
