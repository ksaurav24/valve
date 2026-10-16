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
          Changes for plain-numbered versions, generated from{' '}
          <a
            className="text-foreground underline decoration-ring underline-offset-4 hover:decoration-foreground"
            href={`${site.source}/packages/valve/CHANGELOG.md`}
          >
            packages/valve/CHANGELOG.md
          </a>
          . Preview-only history is grouped under plain headings and marked as
          historical notes. Other versions npm does not list are development
          versions. Original build versions remain in the full package
          changelog.
        </p>
      </PageHeader>
      <div className="page-gutter grid items-start gap-10 py-14 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] lg:gap-16">
        <aside className="max-w-sm space-y-5 lg:sticky lg:top-24">
          <h2 className="text-2xl font-medium tracking-tight">
            Release history
          </h2>
          <p className="text-base leading-relaxed text-muted-foreground">
            The package changelog is the source of truth. Published versions and
            development notes keep their original order.
          </p>
          <a
            href="/releases"
            className="inline-flex min-h-11 items-center text-sm font-medium hover:text-live"
          >
            View published releases
          </a>
        </aside>
        <div className="prose changelog-body min-w-0 max-w-[75ch]">
          <Content components={getMDXComponents()} />
        </div>
      </div>
    </>
  );
}
