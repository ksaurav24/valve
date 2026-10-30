import type { ReactNode } from 'react';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { source } from '@/lib/source';
import { AnimatedThemeToggler } from '@/components/magicui/animated-theme-toggler';
import { NpmDownloads } from '@/components/shared/npm-downloads';
import { monthlyDownloads } from '@/lib/npm';
import { site } from '@/lib/site';

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
      githubUrl={site.repository}
      sidebar={{ defaultOpenLevel: 1 }}
      slots={{ themeSwitch: AnimatedThemeToggler }}
      links={[
        { text: 'Articles', url: '/articles' },
        { text: 'Changelog', url: '/changelog' },
        { text: 'Releases', url: '/releases' },
        { text: 'Contributors', url: '/contributors' },
        { text: 'TypeDoc', url: '/api/index.html', external: true },
        {
          type: 'custom',
          secondary: true,
          children: <NpmDownloads initial={monthlyDownloads} />,
        },
      ]}
    >
      {children}
    </DocsLayout>
  );
}
