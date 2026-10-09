import type { Metadata } from 'next';
import Link from 'next/link';
import { site } from '@/lib/site';
import { ServerCodeBlock } from 'fumadocs-ui/components/codeblock.rsc';
import { CodeComparison } from '@/components/magicui/code-comparison';

export const metadata: Metadata = {
  title: { absolute: 'valve: Shared rate limits for outbound API calls' },
  description:
    'A TypeScript library for outbound API rate limits, shared budgets, and provider backoff. Memory, Redis, and Valkey stores with zero runtime dependencies.',
};

const localExample = `import { createValve } from '@ksaurav24/valve';

const api = createValve({
  id: 'partner:credential-42',
  rate: { limit: 100, interval: '1s' },
});

const limitedFetch = api.wrapFetch();
await limitedFetch('https://api.example.com/contacts');
await api.close({ drain: true });`;

const sharedExample = `import { createValve } from '@ksaurav24/valve';
import { redisStore } from '@ksaurav24/valve/redis';

const api = createValve({
  id: 'partner:credential-42',
  rate: { limit: 100, interval: '1s' },
  store: redisStore({ client: redis }),
});

const limitedFetch = api.wrapFetch();
await limitedFetch('https://api.example.com/contacts');
await api.close({ drain: true });`;

export default function HomePage() {
  return (
    <>
      <section
        className="home-introduction"
        aria-labelledby="introduction-title"
      >
        <div className="introduction-copy">
          <h1 id="introduction-title">
            Shared rate limits for outbound calls.
          </h1>
          <p className="introduction-lead">
            Coordinate API calls under one quota, even when several processes
            use the same credential. valve shares the rate budget and provider
            pauses across your workers.
          </p>
          <p>
            Start with an in-memory store for a script. Add Redis or Valkey when
            calls span processes. TypeScript types, ESM and CommonJS builds, and
            zero runtime dependencies are included.
          </p>
          <nav className="introduction-links" aria-label="Start reading">
            <Link href="/docs/quickstart">Quickstart</Link>
            <Link href="/docs/reference/api">API reference</Link>
            <a href={site.repository}>Source code</a>
          </nav>
        </div>
        <aside className="project-note" aria-label="Package status">
          <dl>
            <div>
              <dt>Latest recorded version</dt>
              <dd>
                <Link href="/changelog">{site.version}</Link>
              </dd>
            </div>
            <div>
              <dt>License</dt>
              <dd>
                <a href={`${site.source}/LICENSE`}>Apache 2.0</a>
              </dd>
            </div>
          </dl>
          <p>
            The package is not on npm yet.{' '}
            <Link href="/docs/installation">
              Build and install from source.
            </Link>
          </p>
        </aside>
      </section>

      <section className="usage-section" aria-labelledby="usage-title">
        <div className="usage-introduction">
          <div className="section-copy">
            <h2 id="usage-title">
              Start locally. Share the budget when you need to.
            </h2>
            <p>
              Keep the same API when you move from one process to several
              workers. Add a store to coordinate the quota; each process still
              owns its queue.
            </p>
          </div>
          <p className="usage-note">
            The Redis example expects your connected client. valve does not open
            or close that connection.{' '}
            <Link href="/docs/guides/share-a-quota">Redis setup guide</Link>
          </p>
        </div>
        <CodeComparison
          beforeLabel="One process"
          afterLabel="Shared workers"
          beforeCode={
            <ServerCodeBlock
              code={localExample}
              lang="ts"
              themes={{ light: 'github-light', dark: 'github-dark' }}
              codeblock={{
                title: 'local.ts',
                className: 'site-code-block',
                viewportProps: { 'aria-label': 'In-memory rate limit example' },
              }}
            />
          }
          afterCode={
            <ServerCodeBlock
              code={sharedExample}
              lang="ts"
              themes={{ light: 'github-light', dark: 'github-dark' }}
              codeblock={{
                title: 'shared.ts',
                className: 'site-code-block',
                viewportProps: { 'aria-label': 'Shared Redis budget example' },
              }}
            />
          }
        />
      </section>

      <section className="behavior-section" aria-labelledby="behavior-title">
        <h2 id="behavior-title">Rules, feedback, and queues</h2>
        <dl className="behavior-list">
          <div>
            <dt>Rate rules</dt>
            <dd>
              <p>
                GCRA spaces starts; fixed windows cap aligned intervals. Several
                rules can be checked atomically when a provider has both short
                and long quotas.
              </p>
              <Link href="/docs/choosing-an-algorithm">
                Choose an algorithm
              </Link>
            </dd>
          </div>
          <div>
            <dt>Provider feedback</dt>
            <dd>
              <p>
                Read Retry-After and rate limit headers, share pauses, and retry
                rate limit responses through <code>wrapFetch</code>.
                Already-issued grants can still start.
              </p>
              <Link href="/docs/guides/respect-retry-after">
                Respect provider backoff
              </Link>
            </dd>
          </div>
          <div>
            <dt>Concurrency and queues</dt>
            <dd>
              <p>
                Set local priorities, job costs, queue bounds, and wait
                deadlines. Limit running work locally or share a concurrency
                limit through renewable leases.
              </p>
              <Link href="/docs/guides/global-concurrency">
                Share a concurrency limit
              </Link>
            </dd>
          </div>
        </dl>
      </section>

      <section className="limits-section" aria-labelledby="limits-title">
        <div>
          <h2 id="limits-title">Scope and guarantees</h2>
          <p>
            Rate bounds apply at atomic store admission. Network delays can
            bunch requests together before they reach the provider.
          </p>
          <Link className="text-link" href="/docs/guarantees">
            Read the guarantees
          </Link>
        </div>
        <div className="limits-detail">
          <p>
            Queued jobs live in the process and do not survive a restart. Use a
            durable job queue to preserve work, then apply valve around outbound
            calls.
          </p>
          <p>
            Shared concurrency uses leases. Strict partition safety requires
            external fencing; queue ordering and fairness remain local.
          </p>
          <Link className="text-link" href="/docs/examples">
            Usage examples
          </Link>
        </div>
      </section>
    </>
  );
}
