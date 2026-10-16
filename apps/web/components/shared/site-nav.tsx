'use client';

import { useRef } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Menu } from 'lucide-react';
import { SearchTrigger } from 'fumadocs-ui/layouts/shared/slots/search-trigger';
import { AnimatedThemeToggler } from '@/components/magicui/animated-theme-toggler';
import { FluidHoverHighlight } from '@/components/fluid-hover-highlight';
import { GitHubStars } from '@/components/shared/github-stars';
import { NpmDownloads } from '@/components/shared/npm-downloads';
import {
  DropdownContent,
  DropdownMenu,
  DropdownTrigger,
} from '@/components/ui/dropdown';
import { MenuItem } from '@/components/ui/menu-item';
import { useFluidHover } from '@/hooks/use-fluid-hover';
import { navLinks } from '@/lib/nav';
import { cn } from '@/lib/utils';

function isActive(pathname: string, href: string) {
  return href === '/' ? pathname === '/' : pathname.startsWith(href);
}

export function SiteNav({
  stars,
  downloads,
}: {
  stars: number;
  downloads: number | null;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const listRef = useRef<HTMLDivElement>(null);
  const hover = useFluidHover(listRef, { axis: 'x' });
  const activeIndex = navLinks.findIndex(({ href }) =>
    isActive(pathname, href),
  );

  return (
    <header className="sticky top-0 z-40 bg-background">
      <div className="page-gutter flex h-14 w-full items-center gap-2 sm:gap-4">
        <Link
          href="/"
          className="shrink-0 font-mono text-[15px] font-semibold tracking-tight text-foreground"
          aria-label="valve home"
        >
          valve<span className="text-muted-foreground">_</span>
        </Link>

        <nav aria-label="Main navigation" className="hidden lg:block">
          <div
            ref={listRef}
            className="relative flex items-center"
            {...hover.handlers}
          >
            <FluidHoverHighlight hover={hover} className="rounded-md" />
            {navLinks.map(({ href, label }, index) => (
              <Link
                key={href}
                href={href}
                ref={(el) => hover.registerItem(index, el)}
                data-fluid-hover-index={index}
                aria-current={index === activeIndex ? 'page' : undefined}
                className={cn(
                  'relative z-10 rounded-md px-3 py-2 text-sm text-muted-foreground hover:text-foreground aria-[current=page]:text-foreground',
                )}
              >
                {label}
                {index === activeIndex && (
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-3 -bottom-1 h-0.5 bg-foreground"
                  />
                )}
              </Link>
            ))}
          </div>
        </nav>

        <div className="ml-auto flex items-center gap-1 sm:gap-1.5">
          <SearchTrigger
            hideIfDisabled
            className="text-muted-foreground"
            aria-label="Search documentation"
          />
          <GitHubStars initial={stars} />
          <NpmDownloads initial={downloads} />
          <AnimatedThemeToggler />
          <div className="lg:hidden">
            <DropdownMenu>
              <DropdownTrigger
                aria-label="Open navigation"
                className="grid size-9 place-items-center rounded-md text-muted-foreground hover:bg-hover hover:text-foreground"
              >
                <Menu className="size-4" />
              </DropdownTrigger>
              <DropdownContent
                align="end"
                checkedIndex={activeIndex === -1 ? undefined : activeIndex}
              >
                {navLinks.map(({ href, label }, index) => (
                  <MenuItem
                    key={href}
                    index={index}
                    label={label}
                    checked={index === activeIndex}
                    onSelect={() => router.push(href)}
                  />
                ))}
              </DropdownContent>
            </DropdownMenu>
          </div>
        </div>
      </div>
    </header>
  );
}
