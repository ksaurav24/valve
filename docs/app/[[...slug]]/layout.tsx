import type { ReactNode } from 'react';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { Brand } from '@/components/brand';
import { source } from '@/lib/source';

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout
      tree={source.getPageTree()}
      nav={{ title: <Brand />, url: '/' }}
      githubUrl="https://github.com/ksaurav24/valve"
      sidebar={{
        defaultOpenLevel: 2,
        footer: (
          <p className="sidebar-note">
            A shared budget for your outbound calls.
          </p>
        ),
      }}
      links={[
        { text: 'Generated API', url: '/api/index.html', external: true },
      ]}
    >
      {children}
    </DocsLayout>
  );
}
