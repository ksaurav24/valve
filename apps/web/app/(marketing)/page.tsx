import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { ArrowRight, ArrowUpRight } from 'lucide-react';
import { ChangelogSections } from '@/components/marketing/changelog-entry';
import { CodeTabs } from '@/components/marketing/code-tabs';
import { AvatarStack } from '@/components/marketing/contributor-grid';
import { FeatureList } from '@/components/marketing/feature-grid';
import { ValveFlow } from '@/components/marketing/valve-flow';
import { HeroActions } from '@/components/marketing/hero-actions';
import { HeroHeading, HeroReveal } from '@/components/marketing/hero-reveal';
import { InstallCli } from '@/components/marketing/install-cli';
import { highlight } from '@/components/shared/highlight';
import { VersionBadge } from '@/components/shared/version-badge';
import { contributors } from '@/lib/github';
import { changelogEntries, current, versionState } from '@/lib/releases';
import { pageMetadata } from '@/lib/metadata';
import { site } from '@/lib/site';

export const metadata: Metadata = pageMetadata({
  title: site.title,
  path: '/',
  absoluteTitle: true,
});

const samples = [
  {
    file: 'local.ts',
    code: `import { createValve } from 'valvejs';

const api = createValve({
  id: 'partner:credential-42',
  rate: { limit: 100, interval: '1s' },
});

// GET retries after the provider's Retry-After; POST needs retryUnsafeMethods.
const limitedFetch = api.wrapFetch();
await limitedFetch('https://api.example.com/contacts');
await api.close({ drain: true });`,
  },
  {
    file: 'shared.ts',
    code: `import { createValve } from 'valvejs';
import { redisStore } from 'valvejs/redis';

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
    file: 'scoped.ts',
    code: `import { createValve } from 'valvejs';

const messages = createValve({
  id: 'business-42',
  rate: [
    { name: 'shared', limit: 80, interval: '1s', burst: 8 },
    { name: 'spacing', scope: 'recipient', limit: 1, interval: '6s' },
  ],
});

// Spend both budgets, or neither. Other recipients can proceed while A waits.
await messages.run(() => sendMessage(), {
  scopes: { recipient: 'contact-A' },
});
await messages.close();`,
  },
  {
    file: 'queue.ts',
    code: `import { createValve } from 'valvejs';

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
  const recent = changelogEntries.slice(0, 3);

  return (
    <div className="marketing-home">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            '@context': 'https://schema.org',
            '@graph': [
              {
                '@type': 'WebSite',
                '@id': `${site.url}/#website`,
                name: site.name,
                url: `${site.url}/`,
                description: site.description,
                inLanguage: 'en',
              },
              {
                '@type': 'SoftwareSourceCode',
                name: site.packageName,
                alternateName: site.name,
                url: `${site.url}/`,
                description: site.description,
                codeRepository: site.repository,
                programmingLanguage: 'TypeScript',
                license: 'https://www.apache.org/licenses/LICENSE-2.0',
                version: site.version,
              },
            ],
          }).replace(/</g, '\\u003c'),
        }}
      />
      <header className="home-hero">
        <div className="page-gutter hero-layout">
          <div className="hero-copy">
            <h1 className="hero-title">
              <HeroHeading lines={['Many workers.', 'One rate limit.']} />
            </h1>
            <HeroReveal delay={0.16}>
              <p className="hero-description">
                A TypeScript library for outbound API calls. Share one rate
                budget and provider pauses across every worker.
              </p>
            </HeroReveal>
            <HeroReveal delay={0.26} className="space-y-5">
              <HeroActions />
              <p className="text-sm text-muted-foreground">
                Beta until 1.0. APIs may change between releases.
              </p>
            </HeroReveal>
          </div>
          <HeroReveal delay={0.2} from="right" className="hero-stage">
            <ValveFlow />
          </HeroReveal>
        </div>
        <HeroReveal delay={0.42} className="page-gutter hero-footer">
          <dl className="hero-facts">
            <Stat label="Runtime dependencies" value="0" />
            <Stat label="Stores" value="Memory, Redis & Valkey" />
            <Stat label="License" value="Apache 2.0" />
            <div className="space-y-2">
              <dt className="text-sm text-muted-foreground">Current version</dt>
              <dd>
                <VersionBadge className="h-auto min-h-7 max-w-full flex-wrap gap-y-1 py-1" />
              </dd>
            </div>
          </dl>
        </HeroReveal>
      </header>

      <section
        id="readme"
        aria-labelledby="readme-title"
        className="page-gutter section-space bg-card"
      >
        <div className="readme-layout">
          <HeroReveal onView className="readme-note">
            <h2 id="readme-title" className="section-title">
              <code className="font-mono">README.md</code>
            </h2>
            <p className="mt-6 max-w-[28ch] text-2xl leading-snug tracking-tight">
              Start local. Share when needed.
            </p>
            <p className="section-copy mt-6">
              Start with an in-memory store for a script. Add Redis or Valkey
              when calls span processes. Same API, same guarantees: rate bounds
              apply at atomic store admission.
            </p>
            <InlineLink href="/docs/installation">
              Installation guide
            </InlineLink>
          </HeroReveal>
          <HeroReveal onView delay={0.08} className="min-w-0 space-y-6">
            <div id="install" className="scroll-mt-24">
              <InstallCli published={current.state !== 'dev'} />
            </div>
            <div id="usage" className="scroll-mt-24">
              <CodeTabs tabs={tabs} />
            </div>
            <p className="max-w-[64ch] text-sm leading-relaxed text-muted-foreground">
              The Redis example expects your connected client. valve does not
              open or close it.{' '}
              <Link
                href="/docs/guides/share-a-quota"
                className="text-foreground underline decoration-ring underline-offset-4"
              >
                Share a quota
              </Link>
            </p>
          </HeroReveal>
        </div>
      </section>

      <section
        id="features"
        aria-labelledby="features-title"
        className="page-gutter section-space"
      >
        <div className="capabilities-layout">
          <HeroReveal onView className="capabilities-intro">
            <h2 id="features-title" className="section-title">
              Control the
              <br />
              shared budget.
            </h2>
            <p className="section-copy mt-6">
              Space starts, share quotas, and respect the provider’s backoff.
              Keep the scheduling rules in one place.
            </p>
            <InlineLink href="/docs/guarantees">Read the guarantees</InlineLink>
          </HeroReveal>
          <HeroReveal onView delay={0.08} className="min-w-0">
            <FeatureList />
          </HeroReveal>
        </div>
      </section>

      <section
        id="changelog"
        aria-labelledby="changelog-title"
        className="page-gutter section-space bg-card"
      >
        <HeroReveal onView className="section-heading-row">
          <h2 id="changelog-title" className="section-title">
            Changes, in the open.
          </h2>
          <InlineLink href="/changelog">All changes</InlineLink>
        </HeroReveal>
        <ol className="release-index">
          {recent.map((entry) => (
            <li key={entry.version} className="release-row">
              <HeroReveal onView>
                <Link
                  href="/changelog"
                  className="font-mono text-xl tracking-tight hover:text-live-foreground"
                >
                  v{entry.version}
                </Link>
                <p className="mt-2 text-sm text-muted-foreground">
                  {versionState(entry.version) === 'dev'
                    ? 'Unreleased'
                    : versionState(entry.version)}
                </p>
              </HeroReveal>
              <HeroReveal onView delay={0.06} className="min-w-0">
                <ChangelogSections sections={entry.sections} limit={2} />
              </HeroReveal>
            </li>
          ))}
        </ol>
      </section>

      <section
        id="contributors"
        aria-labelledby="contributors-title"
        className="page-gutter section-space"
      >
        <div className="community-layout">
          <HeroReveal onView>
            <h2 id="contributors-title" className="section-title">
              Built in the open.
            </h2>
            <p className="section-copy mt-5">
              Code, docs, benchmarks, and careful bug reports. Every
              contribution counts.
            </p>
          </HeroReveal>
          <HeroReveal
            onView
            delay={0.08}
            className="flex flex-col items-start gap-7"
          >
            <AvatarStack contributors={contributors} />
            <InlineLink href="/contributors">Meet the contributors</InlineLink>
          </HeroReveal>
        </div>
      </section>

      <section
        id="next"
        aria-labelledby="next-title"
        className="page-gutter section-space bg-card"
      >
        <div className="next-layout">
          <HeroReveal onView>
            <h2 id="next-title" className="section-title">
              Make your first call.
            </h2>
            <p className="section-copy mt-5">
              Start with a limited fetch. Keep the same API as your workload
              grows.
            </p>
          </HeroReveal>
          <HeroReveal onView delay={0.08} className="docs-index">
            <NextLink href="/docs/quickstart" title="Read the quickstart">
              A limited fetch in five minutes.
            </NextLink>
            <NextLink href="/docs/guarantees" title="Understand the guarantees">
              What valve promises, and where the bounds apply.
            </NextLink>
            <NextLink
              href="/docs/migration/from-bottleneck"
              title="Moving from Bottleneck?"
            >
              Map options and behavior one to one.
            </NextLink>
          </HeroReveal>
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-2">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-base font-medium tracking-tight">{value}</dd>
    </div>
  );
}

function InlineLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="inline-doc-link">
      {children}
      <ArrowUpRight aria-hidden="true" className="size-4" />
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
    <Link href={href} className="docs-index-link group">
      <span>
        <span className="block text-lg font-medium tracking-tight">
          {title}
        </span>
        <span className="mt-2 block text-sm leading-relaxed text-muted-foreground">
          {children}
        </span>
      </span>
      <ArrowRight
        aria-hidden="true"
        className="mt-1 size-5 shrink-0 transition-transform group-hover:translate-x-1 motion-reduce:transform-none"
      />
    </Link>
  );
}
