import type { Metadata } from 'next';
import Link from 'next/link';
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
  if (!page)
    throw new Error('Run the changelog sync before building the site.');
  const Content = page.data.body;
  return (
    <div className="editorial-page changelog-page">
      <header className="page-intro">
        <h1>Changelog</h1>
        <p>Recorded package changes, from the repository’s changelog.</p>
      </header>
      <aside className="release-notice">
        <strong>Latest recorded version: {site.version}</strong>
        <p>
          The package has not been published to npm.{' '}
          <Link href="/docs/installation">Install from source</Link> to try it.
        </p>
      </aside>
      <div className="prose changelog-body">
        <Content components={getMDXComponents()} />
      </div>
      <p className="source-note">
        Generated from{' '}
        <a href={`${site.source}/packages/valve/CHANGELOG.md`}>
          packages/valve/CHANGELOG.md
        </a>
        .{' '}
        <Link href="/docs/reference/implementation-status">
          Read current status and limitations.
        </Link>
      </p>
    </div>
  );
}
