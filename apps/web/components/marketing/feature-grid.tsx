import {
  Card,
  CardContent,
  CardDescription,
  CardEyebrow,
  CardGroup,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

const features = [
  {
    title: 'Shared rate rules.',
    description:
      'GCRA spaces starts; fixed windows cap aligned intervals. Several rules are checked atomically.',
    snippet:
      "rate: [{ limit: 10, interval: '1s' }, { limit: 5000, interval: '1h' }]",
    href: '/docs/choosing-an-algorithm',
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

export function FeatureGrid() {
  return (
    <CardGroup columns={2} border="outlined" className="max-sm:hidden">
      {features.map((feature, index) => (
        <FeatureCard key={feature.href} index={index} {...feature} />
      ))}
    </CardGroup>
  );
}

/** Phones get a single column; the two-column group keeps 2-D fluid hover. */
export function FeatureList() {
  return (
    <CardGroup columns={1} border="outlined" className="sm:hidden">
      {features.map((feature, index) => (
        <FeatureCard key={feature.href} index={index} {...feature} />
      ))}
    </CardGroup>
  );
}

function FeatureCard({
  index,
  title,
  description,
  snippet,
  href,
}: (typeof features)[number] & { index: number }) {
  return (
    <Card href={href} label={title} index={index}>
      <CardHeader>
        <CardEyebrow className="font-mono">
          {String(index + 1).padStart(2, '0')}
        </CardEyebrow>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <code className="block truncate rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-[11.5px] text-muted-foreground">
          {snippet}
        </code>
      </CardContent>
    </Card>
  );
}
