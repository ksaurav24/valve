// Public inference and structural client compatibility under strict TypeScript.
import { expectTypeOf, test } from 'vitest';
import {
  createValve,
  memoryStore,
  isValveError,
  runSequential,
} from '../src/index.js';
import type {
  Store,
  JobContext,
  LimitsPatch,
  LimitsSnapshot,
  ManagedAcquireRequest,
  ManagedAcquireResult,
  ManagedContext,
  ManagedScopedRequest,
  ManagedScopedResult,
  ManagedStore,
  ManagedUpdateRequest,
  ValveError,
  ResponseLike,
  UpdateLimitsOptions,
  RunSequentialOptions,
  SequentialStage,
  ValveStats,
} from '../src/index.js';
import { redisStore } from '../src/redis/index.js';
import { createValveGroup } from '../src/group/index.js';
import type {
  ValveGroup,
  ValveGroupKeyOptions,
  ValveGroupMember,
  ValveGroupOptions,
  ValveGroupStats,
} from '../src/group/index.js';
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

test('managed limits expose readonly snapshots, patches, events, and store requests', () => {
  const store = memoryStore();
  const api = createValve({
    id: 'managed-types',
    rate: { name: 'throughput', limit: 10, interval: '1s', burst: 5 },
    limits: 'managed',
    store,
  });
  expectTypeOf(api.getLimits()).toEqualTypeOf<Promise<LimitsSnapshot>>();
  expectTypeOf(
    api.updateLimits({ throughput: { limit: 20, burst: 10 } }),
  ).toEqualTypeOf<Promise<LimitsSnapshot>>();
  const patch: LimitsPatch = { throughput: { limit: 20 } };
  const options: UpdateLimitsOptions = {
    expect: { throughput: { limit: 10 } },
  };
  expectTypeOf(api.updateLimits(patch, options)).toEqualTypeOf<
    Promise<LimitsSnapshot>
  >();
  api.on('limits', (snapshot) => {
    expectTypeOf(snapshot).toEqualTypeOf<LimitsSnapshot>();
    expectTypeOf(snapshot.rules.throughput!.limit).toEqualTypeOf<number>();
  });
  expectTypeOf(store.managed).toEqualTypeOf<ManagedStore | undefined>();

  const snapshot = {} as LimitsSnapshot;
  // @ts-expect-error Managed snapshots are readonly.
  snapshot.revision = 2;
  // @ts-expect-error Managed rule values are readonly.
  snapshot.rules.throughput!.limit = 20;
  // @ts-expect-error Structural fields cannot be patched.
  api.updateLimits({ throughput: { interval: 2000 } });
  // @ts-expect-error Unknown managed mode.
  createValve({ id: 'bad-managed-mode', concurrency: 1, limits: 'dynamic' });
});

test('custom managed store capability has typed contexts and results', () => {
  const acquire = async (
    request: ManagedAcquireRequest,
  ): Promise<ManagedAcquireResult> => ({
    granted: request.costs.length,
    retryAfterMs: 0,
    pausedMs: 0,
  });
  const acquireScoped = async (
    request: ManagedScopedRequest,
  ): Promise<ManagedScopedResult> => ({
    grantedIndexes: request.jobs.map((_, index) => index),
    blocked: [],
  });
  const capability: ManagedStore = {
    version: 1,
    acquire,
    acquireScoped,
    getLimits: async (context: ManagedContext) => {
      expectTypeOf(context.known).toEqualTypeOf<string | undefined>();
      return {} as LimitsSnapshot;
    },
    updateLimits: async (request: ManagedUpdateRequest) => {
      expectTypeOf(request.patch).toEqualTypeOf<LimitsPatch>();
      expectTypeOf(request.expect).toEqualTypeOf<LimitsPatch | undefined>();
      return {} as LimitsSnapshot;
    },
  };
  expectTypeOf(capability.version).toEqualTypeOf<1>();
});
test('runSequential infers results and keeps options per stage', () => {
  const a = createValve({ id: 'types-seq-a', concurrency: 1 });
  const b = createValve({ id: 'types-seq-b', concurrency: 1 });
  expectTypeOf(runSequential([{ valve: a }], () => 42)).toEqualTypeOf<
    Promise<number>
  >();
  expectTypeOf(
    runSequential(
      [{ valve: a, options: { cost: 2 } }, { valve: b }],
      async ({ signal }) => ({ aborted: signal?.aborted }),
      { signal: new AbortController().signal },
    ),
  ).toEqualTypeOf<Promise<{ aborted: boolean | undefined }>>();
  void runSequential(
    [
      {
        valve: a,
        options: {
          observe: (result) => {
            expectTypeOf(result).toEqualTypeOf<ResponseLike>();
            return result;
          },
        },
      },
    ],
    async (): Promise<ResponseLike> => ({ status: 200, headers: {} }),
  );
  // Any object with id and run, such as a group member, is a stage.
  void runSequential([{ valve: { id: 'member', run: a.run } }], () => 1);
  const stages: SequentialStage[] = [{ valve: a }, { valve: b }];
  expectTypeOf(runSequential(stages, () => 'x')).toEqualTypeOf<
    Promise<string>
  >();
  // @ts-expect-error The shared signal is not a per-stage option.
  void runSequential([{ valve: a, options: { signal: undefined } }], () => 1);
  const options: RunSequentialOptions = {};
  // @ts-expect-error Stages need a valve.
  void runSequential([{ options: {} }], () => 1, options);
});
test('groups infer keys, preserve run types, and hide child handles', async () => {
  type Tenant = `tenant-${number}`;
  const tenants = createValveGroup({
    id: 'crm:tenants',
    resolve: (tenant: Tenant) => ({
      rate: { name: 'tenant', limit: tenant.length, interval: '1s' },
      limits: 'managed',
    }),
  });
  expectTypeOf(tenants).toEqualTypeOf<ValveGroup<Tenant>>();
  expectTypeOf(
    tenants.run('tenant-1', () => Promise.resolve(42), { priority: 5 }),
  ).toEqualTypeOf<Promise<number>>();
  // @ts-expect-error keys must match the resolver's key type
  void tenants.run('other', () => 1);
  const member = tenants.get('tenant-2');
  expectTypeOf(member).toEqualTypeOf<ValveGroupMember<Tenant>>();
  expectTypeOf(member.key).toEqualTypeOf<Tenant>();
  expectTypeOf(member.stats()).toEqualTypeOf<ValveStats | undefined>();
  expectTypeOf(member.updateLimits({ tenant: { limit: 5 } })).toEqualTypeOf<
    Promise<LimitsSnapshot>
  >();
  expectTypeOf(member.wrap((id: string) => id.length)).toEqualTypeOf<
    (id: string) => Promise<number>
  >();
  // @ts-expect-error members cannot close the group's child valve
  void member.close();
  expectTypeOf(tenants.stats()).toEqualTypeOf<ValveGroupStats>();
  tenants.on('pause', (event, key) => {
    expectTypeOf(event.durationMs).toEqualTypeOf<number>();
    expectTypeOf(key).toEqualTypeOf<Tenant>();
  });
  createValveGroup({
    id: 'g',
    // @ts-expect-error the group derives the id and shares its store
    resolve: () => ({ id: 'x', concurrency: 1 }),
  });
  const options: ValveGroupKeyOptions = { concurrency: 1 };
  const typed: ValveGroupOptions = { id: 'g', resolve: () => options };
  expectTypeOf(createValveGroup(typed)).toEqualTypeOf<ValveGroup<string>>();
  await tenants.close({ drain: true });
});
