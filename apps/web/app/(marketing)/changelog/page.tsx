import type { Metadata } from 'next';
import { PageHeader } from '@/components/marketing/page-header';
import { VersionBadge } from '@/components/shared/version-badge';
import { changelogSource } from '@/lib/source';
import { getMDXComponents } from '@/mdx-components';
import { site } from '@/lib/site';

export const metadata: Metadata = {
  title: 'Changelog',
  description:
    'Version history and package changes for valve, generated from the package changelog.',
};

export default function ChangelogPage() {
  const page = changelogSource.getPage([]);
  if (!page) throw new Error('Run the content sync before building the site.');
  const Content = page.data.body;
  return (
    <>
      <PageHeader
        eyebrow="changelog"
        title="Changelog"
        aside={<VersionBadge />}
      >
        <p>
          Every recorded package change, generated from{' '}
          <a
            className="text-foreground underline decoration-ring underline-offset-4 hover:decoration-foreground"
            href={`${site.source}/packages/valve/CHANGELOG.md`}
          >
            packages/valve/CHANGELOG.md
          </a>
          . Versions npm does not list are development versions.
        </p>
      </PageHeader>
      <div className="mx-auto max-w-5xl px-4 py-12 sm:px-6">
        <div className="prose changelog-body max-w-3xl">
          <Content components={getMDXComponents()} />
        </div>
      </div>
    </>
  );
}
