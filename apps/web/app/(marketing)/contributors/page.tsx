import type { Metadata } from 'next';
import { CircleDot, GitPullRequest, Scale } from 'lucide-react';
import { PageHeader } from '@/components/marketing/page-header';
import { ContributorGrid } from '@/components/marketing/contributor-grid';
import { contributors } from '@/lib/github';
import { site } from '@/lib/site';
import { contributingSource } from '@/lib/source';
import { getMDXComponents } from '@/mdx-components';
import { pageMetadata } from '@/lib/metadata';

export const metadata: Metadata = pageMetadata({
  title: 'Contributors',
  description: 'The people building valve, and how to contribute.',
  path: '/contributors',
});

const starters = [
  {
    icon: CircleDot,
    title: 'Good first issues',
    description: 'Find an issue to work on for your first contribution.',
    href: `${site.repository}/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22`,
  },
  {
    icon: GitPullRequest,
    title: 'Open pull requests',
    description: 'Review proposed changes and join the discussion.',
    href: `${site.repository}/pulls`,
  },
  {
    icon: Scale,
    title: 'Code of Conduct',
    description: 'Community expectations and how to report a concern.',
    href: `${site.source}/CODE_OF_CONDUCT.md`,
  },
];

export default function ContributorsPage() {
  const guide = contributingSource.getPage([]);
  if (!guide) throw new Error('Run the content sync before building the site.');
  const Guide = guide.data.body;
  return (
    <>
      <PageHeader eyebrow="contributors" title="Contributors">
        <p>
          {contributors.length}{' '}
          {contributors.length === 1 ? 'person has' : 'people have'} contributed
          to valve. See their work and find out how to contribute.
        </p>
      </PageHeader>
      <div className="page-gutter space-y-20 py-16">
        <section aria-labelledby="people">
          <h2 id="people" className="mb-8 text-2xl font-medium tracking-tight">
            Contributors
          </h2>
          <ContributorGrid contributors={contributors} />
        </section>

        <section aria-labelledby="start">
          <h2 id="start" className="mb-8 text-2xl font-medium tracking-tight">
            Get involved
          </h2>
          <div className="grid gap-6 lg:grid-cols-3">
            {starters.map(({ icon: Icon, title, description, href }) => (
              <a
                key={title}
                href={href}
                className="group flex flex-col items-start rounded-md bg-card p-6 hover:bg-muted"
              >
                <Icon className="size-4 text-muted-foreground transition-colors duration-150 group-hover:text-foreground" />
                <span className="mt-5 block text-lg font-medium">{title}</span>
                <span className="mt-2 block text-base leading-relaxed text-muted-foreground">
                  {description}
                </span>
              </a>
            ))}
          </div>
        </section>

        <section
          id="guide"
          aria-labelledby="guide-title"
          className="scroll-mt-20"
        >
          <div className="mb-6 flex flex-wrap items-baseline justify-between gap-3">
            <h2
              id="guide-title"
              className="text-2xl font-medium tracking-tight"
            >
              Contribution guide
            </h2>
            <a
              href={`${site.source}/CONTRIBUTING.md`}
              className="font-mono text-sm text-muted-foreground hover:text-foreground"
            >
              CONTRIBUTING.md
            </a>
          </div>
          <div className="prose max-w-[75ch] lg:ml-[calc(100%/3)]">
            <Guide components={getMDXComponents()} />
          </div>
        </section>
      </div>
    </>
  );
}
