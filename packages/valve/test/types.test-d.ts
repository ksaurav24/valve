// Public inference and structural client compatibility under strict TypeScript.
import { expectTypeOf, test } from 'vitest';
import { createValve, memoryStore, isValveError } from '../src/index.js';
import type {
  Store,
  JobContext,
  ValveError,
  ResponseLike,
} from '../src/index.js';
import { redisStore } from '../src/redis/index.js';
import { Redis } from 'ioredis';
import { createClient } from 'redis';
test('run and wrap preserve awaited return types', () => {
  const api = createValve({ id: 'types', concurrency: 1 });
  expectTypeOf(api.run(() => 42)).toEqualTypeOf<Promise<number>>();
  expectTypeOf(api.run(async () => ({ id: 'x' }))).toEqualTypeOf<
    Promise<{ id: string }>
  >();
  expectTypeOf(
    api.wrap((id: string, active: boolean) => ({ id, active })),
  ).toEqualTypeOf<
    (id: string, active: boolean) => Promise<{ id: string; active: boolean }>
  >();
  expectTypeOf(api.wrapFetch()).toEqualTypeOf<typeof fetch>();
  const fake = async (url: string): Promise<ResponseLike> => ({
    status: 200,
    headers: { url },
  });
  expectTypeOf(api.wrapFetch(fake)).toEqualTypeOf<typeof fake>();
  expectTypeOf(
    api.wrapFetch(fake, {
      retryUnsafeMethods: true,
      retries: 1,
      maxReplayBodySize: 65536,
    }),
  ).toEqualTypeOf<typeof fake>();
  // @ts-expect-error Retry opt-in must be a boolean.
  api.wrapFetch(fake, { retryUnsafeMethods: 'true' });
  // @ts-expect-error Replay byte limits must be numeric.
  api.wrapFetch(fake, { maxReplayBodySize: '64kb' });
  expectTypeOf(memoryStore()).toEqualTypeOf<Store>();
  api.run(
    (ctx) => {
      expectTypeOf(ctx).toEqualTypeOf<JobContext>();
      return 1;
    },
    {
      observe: (result) => {
        expectTypeOf(result).toEqualTypeOf<number>();
        return undefined;
      },
    },
  );
  const error: unknown = new Error();
  if (isValveError(error)) expectTypeOf(error).toEqualTypeOf<ValveError>();
  // @ts-expect-error Cost is numeric.
  api.run(() => 1, { cost: 'one' });
});
test('popular clients fit the public structural types', () => {
  const ioredis = new Redis({ lazyConnect: true });
  expectTypeOf(redisStore({ client: ioredis })).toEqualTypeOf<Store>();
  const nodeRedis = createClient();
  expectTypeOf(redisStore({ client: nodeRedis })).toEqualTypeOf<Store>();
});

test('scoped rules and resolvers preserve public inference', () => {
  const api = createValve({
    id: 'scoped-types',
    rate: [
      { name: 'shared', limit: 10, interval: '1s' },
      { name: 'recipient', scope: 'recipient', limit: 1, interval: '6s' },
    ],
  });
  expectTypeOf(api.run(() => 1, { scopes: { recipient: 'A' } })).toEqualTypeOf<
    Promise<number>
  >();
  expectTypeOf(
    api.wrap((id: number) => String(id), { scopes: { recipient: 'A' } }),
  ).toEqualTypeOf<(id: number) => Promise<string>>();
  const fetcher = async (url: string, id: number): Promise<ResponseLike> => ({
    status: 200,
    headers: { url, id: String(id) },
  });
  expectTypeOf(
    api.wrapFetch(fetcher, {
      scopes: (url, id) => {
        expectTypeOf(url).toEqualTypeOf<string>();
        expectTypeOf(id).toEqualTypeOf<number>();
        return { recipient: String(id) };
      },
    }),
  ).toEqualTypeOf<typeof fetcher>();
  // @ts-expect-error Scope identities must be strings.
  api.run(() => 1, { scopes: { recipient: 1 } });
  // @ts-expect-error Scope resolution must be synchronous.
  api.wrapFetch(fetcher, { scopes: async () => ({ recipient: 'A' }) });
});
