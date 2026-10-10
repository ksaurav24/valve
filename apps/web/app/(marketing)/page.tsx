import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { ArrowRight, ArrowUpRight, BookOpen } from 'lucide-react';
import { ChangelogSections } from '@/components/marketing/changelog-entry';
import { CodeTabs } from '@/components/marketing/code-tabs';
import { AvatarStack } from '@/components/marketing/contributor-grid';
import { FeatureGrid, FeatureList } from '@/components/marketing/feature-grid';
import { HeroActions } from '@/components/marketing/hero-actions';
import { InstallCli } from '@/components/marketing/install-cli';
import { highlight } from '@/components/shared/highlight';
import { VersionBadge } from '@/components/shared/version-badge';
import { contributors } from '@/lib/github';
import { current, releases, unreleased, versionState } from '@/lib/releases';

export const metadata: Metadata = {
  title: { absolute: 'valve: Shared rate limits for outbound API calls' },
  description:
    'A TypeScript library for outbound API rate limits, shared budgets, and provider backoff. Memory, Redis, and Valkey stores with zero runtime dependencies.',
};

const samples = [
  {
    file: 'local.ts',
    code: `import { createValve } from '@ksaurav24/valve';

const api = createValve({
  id: 'partner:credential-42',
  rate: { limit: 100, interval: '1s' },
});

const limitedFetch = api.wrapFetch();
await limitedFetch('https://api.example.com/contacts');
await api.close({ drain: true });`,
  },
  {
    file: 'shared.ts',
    code: `import { createValve } from '@ksaurav24/valve';
import { redisStore } from '@ksaurav24/valve/redis';

// Every worker using this credential shares one budget.
const api = createValve({
  id: 'partner:credential-42',
  rate: { limit: 100, interval: '1s' },
  store: redisStore({ client: redis }),
});

const limitedFetch = api.wrapFetch();
await limitedFetch('https://api.example.com/contacts');`,
  },
  {
    file: 'queue.ts',
    code: `import { createValve } from '@ksaurav24/valve';

const github = createValve({
  id: 'github:app-42',
  rate: { limit: 5000, interval: '1h' },
  concurrency: 4,
});

// Interactive work jumps the queue; batch jobs wait their turn.
const user = await github.run(() => octokit.users.getByUsername({ username }), {
  priority: 10,
});

github.on('pause', ({ durationMs }) => console.warn('paused', durationMs));`,
  },
];

export default async function HomePage() {
  const tabs = await Promise.all(
    samples.map(async (sample) => ({
      ...sample,
      html: await highlight(sample.code),
    })),
  );
  const recent = [...unreleased, ...releases].slice(0, 3);

  return (
    <div className="mx-auto grid max-w-[90rem] lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      <aside className="relative border-border lg:sticky lg:top-14 lg:h-[calc(100dvh-3.5rem)] lg:border-r">
        <div
          aria-hidden="true"
          className="bg-grid absolute inset-0 [mask-image:radial-gradient(ellipse_at_top_left,black_20%,transparent_70%)]"
        />
        <div className="relative flex h-full flex-col justify-between gap-12 px-4 py-12 sm:px-6 lg:px-10 lg:py-14">
          <div className="space-y-7">
            <VersionBadge />
            <h1 className="text-balance text-4xl font-semibold leading-[1.05] tracking-tight sm:text-5xl xl:text-[3.6rem]">
              Shared rate limits for outbound API calls.
            </h1>
            <p className="max-w-md text-pretty text-[15px] leading-relaxed text-muted-foreground">
              Coordinate calls under one quota, even when many processes use the
              same credential. valve shares the rate budget and provider pauses
              across every worker.
            </p>
            <HeroActions />
          </div>
          <dl className="grid max-w-md grid-cols-3 gap-4 border-t border-border pt-6 font-mono text-xs">
            <Stat label="runtime deps" value="0" />
            <Stat label="stores" value="memory · redis" />
            <Stat label="license" value="Apache 2.0" />
          </dl>
        </div>
      </aside>

      <div className="min-w-0 border-t border-border lg:border-t-0">
        <Section index="00" title="README.md" id="readme">
          <p className="max-w-2xl text-pretty text-[15px] leading-relaxed text-muted-foreground">
            Start with an in-memory store for a script. Add Redis or Valkey when
            calls span processes. Same API, same guarantees: rate bounds apply
            at atomic store admission.
          </p>
        </Section>

        <Section index="01" title="install" id="install">
          <InstallCli published={current.state !== 'dev'} />
        </Section>

        <Section index="02" title="features" id="features">
          <FeatureGrid />
          <FeatureList />
        </Section>

        <Section index="03" title="usage" id="usage">
          <CodeTabs tabs={tabs} />
          <p className="mt-3 text-xs text-muted-foreground">
            The Redis example expects your connected client. valve does not open
            or close it.{' '}
            <InlineLink href="/docs/guides/share-a-quota">
              Share a quota
            </InlineLink>
          </p>
        </Section>

        <Section
          index="04"
          title="changelog"
          id="changelog"
          action={<InlineLink href="/changelog">All changes</InlineLink>}
        >
          <ol className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
            {recent.map((entry) => (
              <li
                key={entry.version}
                className="grid gap-3 p-4 sm:grid-cols-[8rem_1fr]"
              >
                <div className="flex items-start gap-2 font-mono text-sm sm:flex-col">
                  <span className="text-foreground">v{entry.version}</span>
                  <span className="text-xs text-muted-foreground">
                    {versionState(entry.version) === 'dev'
                      ? 'unreleased'
                      : versionState(entry.version)}
                  </span>
                </div>
                <ChangelogSections sections={entry.sections} limit={2} />
              </li>
            ))}
          </ol>
        </Section>

        <Section
          index="05"
          title="contributors"
          id="contributors"
          action={<InlineLink href="/contributors">Contribute</InlineLink>}
        >
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border bg-card p-4">
            <AvatarStack contributors={contributors} />
            <p className="text-sm text-muted-foreground">
              Issues and pull requests welcome.{' '}
              <InlineLink href="/contributors#guide">Read the guide</InlineLink>
            </p>
          </div>
        </Section>

        <Section index="06" title="next" id="next">
          <div className="grid gap-3 sm:grid-cols-3">
            <NextLink href="/docs/quickstart" title="Quickstart">
              A limited fetch in five minutes.
            </NextLink>
            <NextLink href="/docs/guarantees" title="Guarantees">
              What valve promises, and what it does not.
            </NextLink>
            <NextLink
              href="/docs/migration/from-bottleneck"
              title="From Bottleneck"
            >
              Map options and behavior one to one.
            </NextLink>
          </div>
        </Section>
      </div>
    </div>
  );
}

function Section({
  index,
  title,
  id,
  action,
  children,
}: {
  index: string;
  title: string;
  id: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className="border-b border-border px-4 py-10 sm:px-6 lg:px-10"
    >
      <div className="mb-5 flex items-baseline justify-between gap-4">
        <h2
          id={`${id}-title`}
          className="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground"
        >
          <span className="text-foreground/40">{index}</span>
          <span className="mx-2 text-foreground/25">/</span>
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-foreground">{value}</dd>
    </div>
  );
}

function InlineLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="group inline-flex items-center gap-0.5 font-mono text-xs text-foreground"
    >
      {children}
      <ArrowUpRight className="size-3 transition-transform duration-150 group-hover:-translate-y-px group-hover:translate-x-px" />
    </Link>
  );
}

function NextLink({
  href,
  title,
  children,
}: {
  href: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      className="group rounded-xl border border-border bg-card p-4 hover:border-ring hover:bg-accent"
    >
      <span className="flex items-center gap-2 text-sm font-medium">
        <BookOpen className="size-3.5 text-muted-foreground" />
        {title}
        <ArrowRight className="ml-auto size-3.5 text-muted-foreground transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-foreground" />
      </span>
      <span className="mt-1.5 block text-xs leading-relaxed text-muted-foreground">
        {children}
      </span>
    </Link>
  );
}
