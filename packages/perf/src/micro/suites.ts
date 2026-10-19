/** T0 in-process microbenchmark suite definitions. */

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Bench } from 'tinybench';

interface ValveModule {
  createValve(options: Record<string, unknown>): Valve;
  memoryStore(): Store;
}

interface Valve {
  run<T>(fn: () => T, options?: Record<string, unknown>): Promise<Awaited<T>>;
  wrapFetch(
    fetchImpl: (...args: never[]) => Promise<Response>,
  ): (...args: never[]) => Promise<Response>;
}

interface Store {
  acquireSync?: (request: Record<string, unknown>) => unknown;
}

interface HeadersModule {
  defaultFeedback(response: { status: number; headers: Headers }): unknown;
  retryAfter(): (response: { status: number; headers: Headers }) => unknown;
  ietfRateLimit(): (response: { status: number; headers: Headers }) => unknown;
  xRateLimit(): (response: { status: number; headers: Headers }) => unknown;
}

const noop = () => undefined;
const rule = (name: string, intervalMs: number) => ({
  algorithm: 'gcra',
  burst: 1_000_000,
  intervalMs,
  key: `named:${name}`,
  limit: 1_000_000,
  name,
});

/**
 * Build the T0 benchmarks for one compiled Valve artifact.
 *
 * These suites measure in-process JavaScript costs only. They make no claims
 * about distributed stores or Lua performance.
 */
export async function microSuites(opts: {
  quick: boolean;
  valveModuleUrl: string;
}): Promise<Bench[]> {
  const valveModule = (await import(opts.valveModuleUrl)) as ValveModule;
  const headersUrl = pathToFileURL(
    join(dirname(fileURLToPath(opts.valveModuleUrl)), 'headers', 'index.js'),
  ).href;
  const { defaultFeedback, retryAfter, ietfRateLimit, xRateLimit } =
    (await import(headersUrl)) as HeadersModule;
  const options = {
    iterations: 1,
    retainSamples: true,
    time: opts.quick ? 100 : 1_000,
    warmupIterations: 1,
    warmupTime: opts.quick ? 20 : 200,
  };
  const make = (name: string) => new Bench({ ...options, name });

  const runValve = valveModule.createValve({
    concurrency: 16,
    feedback: false,
    id: 'micro-run',
  });
  const run = make('valve.run');
  run.add('memory/no-rate/batch-1000', async () => {
    await Promise.all(Array.from({ length: 1_000 }, () => runValve.run(noop)));
  });

  const ruledValve = valveModule.createValve({
    concurrency: 16,
    feedback: false,
    id: 'micro-run-rule',
    rate: { burst: 1_000_000, interval: '1s', limit: 1_000_000 },
  });
  const ruledRun = make('valve.run');
  ruledRun.add('memory/gcra-never-binding/batch-1000', async () => {
    await Promise.all(
      Array.from({ length: 1_000 }, () => ruledValve.run(noop)),
    );
  });

  const store = valveModule.memoryStore();
  if (!store.acquireSync)
    throw new Error('Measured Valve build has no memoryStore.acquireSync');
  const oneRuleRequest = {
    costs: [1],
    id: 'micro-store-1',
    rules: [rule('one', 1_000)],
  };
  const fourRuleRequest = {
    costs: [1],
    id: 'micro-store-4',
    rules: [
      rule('a', 1_000),
      rule('b', 2_000),
      rule('c', 3_000),
      rule('d', 4_000),
    ],
  };
  const acquire = make('memoryStore.acquireSync');
  acquire.add('one-rule', () => store.acquireSync?.(oneRuleRequest));
  acquire.add('four-rules', () => store.acquireSync?.(fourRuleRequest));

  const scopedValve = valveModule.createValve({
    batch: 128,
    concurrency: 16,
    feedback: false,
    id: 'micro-scoped',
    rate: [
      {
        burst: 1_000_000,
        interval: '1s',
        limit: 1_000_000,
        name: 'tenant',
        scope: 'tenant',
      },
      {
        burst: 1_000_000,
        interval: '1m',
        limit: 1_000_000,
        name: 'account',
        scope: 'account',
      },
    ],
  });
  let identity = 0;
  const scoped = make('valve.run.scoped');
  scoped.add('two-rules/64-identities', async () => {
    const current = identity++ % 64;
    await scopedValve.run(noop, {
      scopes: { account: `a${current % 8}`, tenant: `t${current}` },
    });
  });

  const feedbackHeaders = new Headers({
    RateLimit: 'limit=100, remaining=0, reset=2',
    'Retry-After': '1',
    'X-RateLimit-Remaining': '0',
    'X-RateLimit-Reset': '2',
  });
  const headers = make('headers');
  headers.add('defaultFeedback/typical', () =>
    defaultFeedback({ headers: feedbackHeaders, status: 429 }),
  );
  const headerResponse = {
    status: 429,
    headers: new Headers({
      'retry-after': '2',
      ratelimit: '"default";r=0;t=2',
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': '2',
    }),
  };
  for (const [name, reader] of [
    ['retryAfter', retryAfter()],
    ['ietfRateLimit', ietfRateLimit()],
    ['xRateLimit', xRateLimit()],
    ['defaultFeedback', defaultFeedback],
  ] as const)
    headers.add(`${name}/429`, () => reader(headerResponse));

  const timers = make('node.timers');
  timers.add(
    'setTimeout-0/round-trip',
    () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
  );
  timers.add(
    'queueMicrotask/round-trip',
    () => new Promise<void>((resolve) => queueMicrotask(resolve)),
  );

  const fakeFetch = async () => new Response(null, { status: 200 });
  const wrappedFetch = ruledValve.wrapFetch(fakeFetch);
  const fetchBench = make('valve.wrapFetch');
  fetchBench.add('fake-200', () => wrappedFetch());

  return [run, ruledRun, acquire, scoped, headers, timers, fetchBench];
}
