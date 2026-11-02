import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import {
  AccordionGroup,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@/components/ui/accordion';

const features = [
  {
    title: 'Rate rules',
    description:
      'Use GCRA for pacing or fixed windows for aligned quotas. All rules for a job are checked in one atomic admission.',
    snippet:
      "rate: [{ limit: 10, interval: '1s' }, { limit: 5000, interval: '1h', algorithm: 'fixed-window' }]",
    href: '/docs/choosing-an-algorithm',
  },
  {
    title: 'Scoped quotas',
    description:
      'Apply shared, tenant, and recipient rules to the same request. A blocked identity can wait while other eligible jobs run.',
    snippet: "api.run(send, { scopes: { recipient: 'contact-42' } })",
    href: '/docs/guides/scoped-rate-limits',
  },
  {
    title: 'Shared quotas',
    description:
      'Share a credential’s rate budget across processes through Redis or Valkey.',
    snippet: 'store: redisStore({ client: redis })',
    href: '/docs/guides/share-a-quota',
  },
  {
    title: 'Provider feedback',
    description:
      'Read Retry-After and rate-limit headers to pause workers using the same shared budget.',
    snippet: 'api.observe({ status: 429, headers })',
    href: '/docs/guides/respect-retry-after',
  },
  {
    title: 'Fetch retries',
    description:
      'Retry eligible 429 responses and 503 responses with a valid Retry-After. POST and PATCH require an explicit opt-in after checking the provider’s idempotency contract.',
    snippet: 'api.wrapFetch(fetch, { retryUnsafeMethods: true })',
    href: '/docs/reference/api',
  },
  {
    title: 'Concurrency limits',
    description:
      'Cap running work per process, or share one limit across workers through renewable leases.',
    snippet: "concurrency: { limit: 4, scope: 'global' }",
    href: '/docs/guides/global-concurrency',
  },
  {
    title: 'Priorities and queue limits',
    description:
      'Set job costs and priorities, bound queue growth, and reject work that waits too long.',
    snippet: 'api.run(() => sync(id), { priority: 10 })',
    href: '/docs/guides/priorities-and-shutdown',
  },
  {
    title: 'Events and stats',
    description:
      'Inspect queue depth and job totals, and listen for pauses, rejections, and store errors.',
    snippet: "api.on('pause', ({ durationMs }) => log(durationMs))",
    href: '/docs/guides/observability',
  },
  {
    title: 'Zero runtime dependencies',
    description:
      'Use ESM or CommonJS with TypeScript declarations. Redis support works with the client supplied by your application.',
    snippet: 'dependencies: {}',
    href: '/docs/installation',
  },
];

export function FeatureList() {
  return (
    <AccordionGroup
      type="multiple"
      defaultValue={[features[0].href]}
      className="capability-list w-full"
    >
      {features.map((feature, index) => (
        <AccordionItem
          key={feature.href}
          value={feature.href}
          index={index}
          className="capability"
        >
          <AccordionTrigger className="capability-summary">
            {feature.title.replace(/\.$/, '')}
          </AccordionTrigger>
          <AccordionContent className="capability-panel">
            <div className="capability-body">
              <p>{feature.description}</p>
              <pre data-ui className="capability-code">
                <code>{feature.snippet}</code>
              </pre>
              <Link
                href={feature.href}
                className="inline-flex min-h-11 items-center gap-2 text-sm font-medium hover:text-live-foreground"
              >
                Read the guide{' '}
                <ArrowUpRight aria-hidden="true" className="size-4" />
              </Link>
            </div>
          </AccordionContent>
        </AccordionItem>
      ))}
    </AccordionGroup>
  );
}
