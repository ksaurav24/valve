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
import { CopyButton } from '@/components/shared/copy-button';
import { highlight } from '@/components/shared/highlight';
import { VersionBadge } from '@/components/shared/version-badge';
import { contributors } from '@/lib/github';
import {
  changelogAnchor,
  changelogEntries,
  current,
  versionState,
} from '@/lib/releases';
import { pageMetadata } from '@/lib/metadata';
import { site } from '@/lib/site';

export const metadata: Metadata = pageMetadata({
  title: site.title,
  path: '/',
  absoluteTitle: true,
});

const skillsInstallCommand = 'npx skills add ksaurav24/valve';

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
              <HeroHeading lines={['Rate limiting for', 'outbound APIs.']} />
            </h1>
            <HeroReveal delay={0.16}>
              <p className="hero-description">
                Queue API requests with rate and concurrency limits. Share
                provider quotas and cooldowns across workers using Redis or
                Valkey.
              </p>
            </HeroReveal>
            <HeroReveal delay={0.26} className="space-y-5">
              <HeroActions />
              <p className="text-sm text-muted-foreground">
                Valve is in beta. APIs may change before 1.0.
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
              Usage
            </h2>
            <p className="mt-6 max-w-[28ch] text-2xl leading-snug tracking-tight">
              Use the same API locally or across workers.
            </p>
            <p className="section-copy mt-6">
              Use the default memory store for a script or a single service.
              Connect Redis or Valkey when several processes need to share a
              quota.
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
              The Redis example uses a connected client supplied by your
              application. You own the connection and its shutdown.{' '}
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
        id="agent-skills"
        aria-labelledby="agent-skills-title"
        className="page-gutter scroll-mt-24 py-10 sm:py-12"
      >
        <div className="readme-layout items-center">
          <div>
            <h2
              id="agent-skills-title"
              className="text-2xl font-medium tracking-tight"
            >
              Agent skills
            </h2>
            <p className="mt-3 max-w-md text-sm leading-relaxed text-muted-foreground">
              Add Valve skills to your coding agent. Choose the ones you need in
              the CLI.
            </p>
          </div>
          <div
            data-ui
            className="flex min-w-0 items-center gap-3 rounded-lg border border-border bg-background py-2 pl-4 pr-2"
          >
            <span
              aria-hidden="true"
              className="font-mono text-sm text-muted-foreground"
            >
              $
            </span>
            <code className="min-w-0 flex-1 break-words font-mono text-[13px] leading-6 select-all">
              {skillsInstallCommand}
            </code>
            <CopyButton
              value={skillsInstallCommand}
              label="Copy skills install command"
              showLabel
            />
          </div>
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
              Rate limits
              <br />
              and queues.
            </h2>
            <p className="section-copy mt-6">
              Configure request pacing, concurrency, and queue limits to match
              the APIs you call.
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
            Recent changes
          </h2>
          <InlineLink href="/changelog">All changes</InlineLink>
        </HeroReveal>
        <ol className="release-index">
          {recent.map((entry) => (
            <li key={entry.version} className="release-row">
              <HeroReveal onView>
                <Link
                  href={`/changelog#${changelogAnchor(entry.version)}`}
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
              Contribute to valve
            </h2>
            <p className="section-copy mt-5">
              Report bugs, improve the documentation, or help with development
              on GitHub.
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
              Documentation
            </h2>
          </HeroReveal>
          <HeroReveal onView delay={0.08} className="docs-index">
            <NextLink href="/docs/quickstart" title="Read the quickstart">
              Configure a valve and send your first request.
            </NextLink>
            <NextLink href="/docs/guarantees" title="Understand the guarantees">
              Rate bounds, cancellation, and store failure behavior.
            </NextLink>
            <NextLink
              href="/docs/migration/from-bottleneck"
              title="Migrate from Bottleneck"
            >
              Compare APIs and behavior before migrating.
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
