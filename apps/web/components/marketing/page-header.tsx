import type { ReactNode } from 'react';

export function PageHeader({
  eyebrow,
  title,
  children,
  aside,
}: {
  eyebrow: string;
  title: string;
  children?: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <header aria-label={eyebrow} className="page-gutter bg-card py-14 sm:py-20">
      <div className="grid items-end gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-16">
        <h1 className="max-w-[16ch] text-balance text-[clamp(2.75rem,5vw,5.5rem)] font-medium leading-[1.05] tracking-[-0.055em]">
          {title}
        </h1>
        <div className="max-w-[60ch] space-y-6 text-base leading-relaxed">
          {children}
          {aside}
        </div>
      </div>
    </header>
  );
}
