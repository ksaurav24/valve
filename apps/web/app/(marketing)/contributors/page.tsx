import type { Metadata } from 'next';
import { CircleDot, GitPullRequest, Scale } from 'lucide-react';
import { PageHeader } from '@/components/marketing/page-header';
import { ContributorGrid } from '@/components/marketing/contributor-grid';
import { contributors } from '@/lib/github';
import { site } from '@/lib/site';
import { contributingSource } from '@/lib/source';
import { getMDXComponents } from '@/mdx-components';

export const metadata: Metadata = {
  title: 'Contributors',
  description: 'The people building valve, and how to contribute.',
};

const starters = [
  {
    icon: CircleDot,
    title: 'Good first issues',
    description: 'Scoped tasks with context, picked for a first change.',
    href: `${site.repository}/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22`,
  },
  {
    icon: GitPullRequest,
    title: 'Open pull requests',
    description: 'Review in-flight work or pick up a stalled change.',
    href: `${site.repository}/pulls`,
  },
  {
    icon: Scale,
    title: 'Code of Conduct',
    description: 'How we work together, and how to report concerns.',
    href: `${site.source}/CODE_OF_CONDUCT.md`,
  },
];

export default function ContributorsPage() {
  const guide = contributingSource.getPage([]);
  if (!guide) throw new Error('Run the content sync before building the site.');
  const Guide = guide.data.body;
  return (
    <>
      <PageHeader eyebrow="contributors" title="Built in the open">
        <p>
          {contributors.length}{' '}
          {contributors.length === 1 ? 'person has' : 'people have'} contributed
          to valve. Fixes, docs, benchmarks, and reviews all count.
        </p>
      </PageHeader>
      <div className="mx-auto max-w-5xl space-y-16 px-4 py-12 sm:px-6">
        <section aria-labelledby="people">
          <h2
            id="people"
            className="mb-5 font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground"
          >
            contributors
          </h2>
          <ContributorGrid contributors={contributors} />
        </section>

        <section aria-labelledby="start">
          <h2
            id="start"
            className="mb-5 font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground"
          >
            start here
          </h2>
          <div className="grid gap-3 sm:grid-cols-3">
            {starters.map(({ icon: Icon, title, description, href }) => (
              <a
                key={title}
                href={href}
                className="group rounded-xl border border-border bg-card p-4 hover:border-ring hover:bg-accent"
              >
                <Icon className="size-4 text-muted-foreground transition-colors duration-150 group-hover:text-foreground" />
                <span className="mt-3 block text-sm font-medium">{title}</span>
                <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
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
              className="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground"
            >
              contribution guide
            </h2>
            <a
              href={`${site.source}/CONTRIBUTING.md`}
              className="font-mono text-xs text-muted-foreground hover:text-foreground"
            >
              CONTRIBUTING.md
            </a>
          </div>
          <div className="prose max-w-3xl">
            <Guide components={getMDXComponents()} />
          </div>
        </section>
      </div>
    </>
  );
}
