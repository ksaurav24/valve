import type { ReactNode } from 'react';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { source } from '@/lib/source';
import { AnimatedThemeToggler } from '@/components/magicui/animated-theme-toggler';

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout
      tree={source.getPageTree()}
      nav={{
        title: (
          <span className="font-mono text-[15px] font-semibold tracking-tight">
            valve<span className="text-fd-muted-foreground">_</span>
          </span>
        ),
        url: '/',
      }}
      githubUrl="https://github.com/ksaurav24/valve"
      sidebar={{ defaultOpenLevel: 1 }}
      slots={{ themeSwitch: AnimatedThemeToggler }}
      links={[
        { text: 'Changelog', url: '/changelog' },
        { text: 'Releases', url: '/releases' },
        { text: 'Contributors', url: '/contributors' },
        { text: 'TypeDoc', url: '/api/index.html', external: true },
      ]}
    >
      {children}
    </DocsLayout>
  );
}
