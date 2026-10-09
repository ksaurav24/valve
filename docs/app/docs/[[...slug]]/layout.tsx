import type { ReactNode } from 'react';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { source } from '@/lib/source';
import { AnimatedThemeToggler } from '@/components/magicui/animated-theme-toggler';

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout
      tree={source.getPageTree()}
      nav={{ title: <span className="wordmark">valve</span>, url: '/' }}
      githubUrl="https://github.com/ksaurav24/valve"
      sidebar={{ defaultOpenLevel: 1 }}
      slots={{ themeSwitch: AnimatedThemeToggler }}
      links={[
        { text: 'Changelog', url: '/changelog' },
        { text: 'TypeDoc', url: '/api/index.html', external: true },
      ]}
    >
      {children}
    </DocsLayout>
  );
}
