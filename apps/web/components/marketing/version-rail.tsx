'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { spring } from '@/lib/springs';
import { cn } from '@/lib/utils';

export interface RailItem {
  id: string;
  version: string;
  /** Marks the npm `latest` version with the live color. */
  latest: boolean;
  muted: boolean;
}

/** Version index that follows the entry closest to the top of the viewport. */
export function VersionRail({
  items,
  label,
  footer,
}: {
  items: RailItem[];
  label: string;
  footer?: ReactNode;
}) {
  const [active, setActive] = useState(items[0]?.id);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    const targets = items
      .map(({ id }) => document.getElementById(id))
      .filter((node): node is HTMLElement => node !== null);
    const visible = new Set<string>();
    if (!('IntersectionObserver' in window)) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries)
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        // Document order wins, so the highest visible entry is active.
        const first = items.find(({ id }) => visible.has(id));
        if (first) setActive(first.id);
      },
      { rootMargin: '-96px 0px -55% 0px' },
    );
    for (const target of targets) observer.observe(target);
    return () => observer.disconnect();
  }, [items]);

  return (
    <nav aria-label={label} className="version-rail">
      <p className="mb-3 text-sm font-medium text-muted-foreground">{label}</p>
      <ol className="flex gap-1 overflow-x-auto pb-2 lg:block lg:max-h-[60vh] lg:space-y-px lg:overflow-y-auto lg:pr-1">
        {items.map((item) => {
          const current = item.id === active;
          return (
            <li key={item.id} className="shrink-0">
              <a
                href={`#${item.id}`}
                aria-current={current ? 'location' : undefined}
                onClick={() => setActive(item.id)}
                className={cn(
                  'relative flex h-8 items-center gap-2.5 rounded-md px-2.5 font-mono text-[13px]',
                  current
                    ? 'text-foreground'
                    : 'text-muted-foreground hover:bg-hover hover:text-foreground',
                )}
              >
                {current && (
                  <motion.span
                    layoutId={`${label}-rail`}
                    transition={
                      reducedMotion ? { duration: 0 } : spring.moderate
                    }
                    aria-hidden="true"
                    className="absolute inset-0 rounded-md bg-accent"
                  />
                )}
                <span
                  aria-hidden="true"
                  className={cn(
                    'relative size-1.5 shrink-0 rounded-full',
                    item.latest
                      ? 'bg-live'
                      : item.muted
                        ? 'border border-muted-foreground/60'
                        : 'bg-muted-foreground/60',
                  )}
                />
                <span className="relative">v{item.version}</span>
              </a>
            </li>
          );
        })}
      </ol>
      {footer ? (
        <div className="mt-3 text-sm lg:mt-6 lg:border-t lg:border-border lg:pt-4">
          {footer}
        </div>
      ) : null}
    </nav>
  );
}
