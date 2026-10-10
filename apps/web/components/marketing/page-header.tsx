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
    <header className="relative overflow-hidden border-b border-border">
      <div
        aria-hidden="true"
        className="bg-grid absolute inset-0 [mask-image:radial-gradient(ellipse_at_top,black_10%,transparent_65%)]"
      />
      <div className="relative mx-auto flex max-w-5xl flex-wrap items-end justify-between gap-6 px-4 py-14 sm:px-6">
        <div className="max-w-2xl space-y-4">
          <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">
            {eyebrow}
          </p>
          <h1 className="text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
            {title}
          </h1>
          {children && (
            <div className="text-pretty text-[15px] leading-relaxed text-muted-foreground">
              {children}
            </div>
          )}
        </div>
        {aside}
      </div>
    </header>
  );
}
