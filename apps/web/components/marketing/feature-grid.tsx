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
    title: 'Shared rate rules.',
    description:
      'GCRA spaces starts; fixed windows cap aligned intervals. Several rules are checked atomically.',
    snippet:
      "rate: [{ limit: 10, interval: '1s' }, { limit: 5000, interval: '1h', algorithm: 'fixed-window' }]",
    href: '/docs/choosing-an-algorithm',
  },
  {
    title: 'Shared and scoped budgets.',
    description:
      'Spend business and per-recipient or per-tenant budgets atomically. Eligible identities proceed while others wait.',
    snippet: "api.run(send, { scopes: { recipient: 'contact-42' } })",
    href: '/docs/guides/scoped-rate-limits',
  },
  {
    title: 'One budget, many workers.',
    description:
      'A Redis or Valkey store shares one quota across processes using the same credential.',
    snippet: 'store: redisStore({ client: redis })',
    href: '/docs/guides/share-a-quota',
  },
  {
    title: 'Provider feedback.',
    description:
      'Reads Retry-After and rate limit headers, then pauses every process sharing the valve.',
    snippet: 'api.observe({ status: 429, headers })',
    href: '/docs/guides/respect-retry-after',
  },
  {
    title: 'A fetch that backs off.',
    description:
      'Retries 429s and 503s with a valid Retry-After for GET, HEAD, OPTIONS, PUT, and DELETE. POST and PATCH opt in.',
    snippet: 'api.wrapFetch(fetch, { retryUnsafeMethods: true })',
    href: '/docs/reference/api',
  },
  {
    title: 'Concurrency limits.',
    description:
      'Cap running work per process, or share one limit across workers through renewable leases.',
    snippet: "concurrency: { limit: 4, scope: 'global' }",
    href: '/docs/guides/global-concurrency',
  },
  {
    title: 'Priorities and deadlines.',
    description:
      'Job costs, queue bounds, wait deadlines, and priorities for interactive work.',
    snippet: 'api.run(() => sync(id), { priority: 10 })',
    href: '/docs/guides/priorities-and-shutdown',
  },
  {
    title: 'Observable.',
    description:
      'Typed events for pauses, rejections, and retries, plus a stats() snapshot per valve.',
    snippet: "api.on('pause', ({ durationMs }) => log(durationMs))",
    href: '/docs/guides/observability',
  },
  {
    title: 'Zero dependencies.',
    description:
      'TypeScript types, ESM and CommonJS builds. It uses the Redis client you pass in.',
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
