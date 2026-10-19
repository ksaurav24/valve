// Real Redis 7.4 and Valkey 8 parity. Never flush or delete outside a unique prefix.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Redis } from 'ioredis';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { NormalizedRule } from 'valvejs';
import {
  runModelTrace,
  runRedisTrace,
  traceArbitrary,
  assertDisposableUrl,
} from '../../src/model/parity.ts';
import type { TraceOp } from '../../src/model/parity.ts';
import { acquire } from '../../src/model/admission.ts';
import { createState } from '../../src/model/state.ts';
import { idealBound } from '../../src/model/capacity.ts';
import { loadScripts } from '../../src/lua/sources.ts';
import { withInjectedClock } from '../../src/lua/clock.ts';
const packageDir = fileURLToPath(new URL('../../../valve', import.meta.url));
const urls =
  process.env.PERF_REDIS_URLS?.split(',').filter(Boolean) ??
  (process.env.PERF_INTEGRATION === '1'
    ? ['redis://127.0.0.1:16479', 'redis://127.0.0.1:16480']
    : []);
const rule: NormalizedRule = {
  algorithm: 'gcra',
  intervalMs: 100,
  limit: 4,
  burst: 3,
  key: 'gcra:100',
};
const prefix = () => `perf-model-test:${randomUUID()}`;
async function parity(url: string, trace: TraceOp[]): Promise<void> {
  const result = await runRedisTrace(url, trace, packageDir, prefix());
  expect(result.results, JSON.stringify({ base: result.base, trace })).toEqual(
    runModelTrace(trace, result.base),
  );
}
for (const url of urls)
  describe(url, () => {
    it.each(['gcra', 'fixed-window', 'multi'] as const)(
      'matches generated fractional/boundary %s weighted-prefix traces (40 cases)',
      async (algorithm) => {
        const rules: NormalizedRule[] =
          algorithm === 'gcra'
            ? [rule]
            : algorithm === 'fixed-window'
              ? [{ ...rule, algorithm, burst: 1, key: 'fixed-window:100' }]
              : [
                  rule,
                  {
                    ...rule,
                    algorithm: 'fixed-window',
                    burst: 1,
                    intervalMs: 200,
                    key: 'fixed-window:200',
                  },
                ];
        for (const trace of fc.sample(traceArbitrary(rules), {
          seed: 642,
          numRuns: 40,
        }))
          await parity(url, trace);
      },
    );
    it('matches generated nonintegral GCRA steps and dynamically targeted eligibility boundaries (30 cases)', async () => {
      const io = new Redis(url);
      const time = await io.time();
      await io.quit();
      const base =
        (Math.ceil((Number(time[0]) * 1000) / 1000000) + 1) * 1000000;
      for (const data of fc.sample(
        fc.record({
          limit: fc.integer({ min: 1, max: 9 }),
          burst: fc.integer({ min: 1, max: 6 }),
          intervalMs: fc.constantFrom(100, 125, 200),
        }),
        { seed: 931, numRuns: 30 },
      )) {
        const r = { ...rule, ...data },
          state = createState();
        acquire(
          state,
          { rules: [r], costs: Array<number>(r.burst).fill(1) },
          base,
        );
        const tat = state.rules.get(r.key)!;
        if (tat.kind !== 'gcra') throw new Error('Expected GCRA');
        const eligible =
          tat.tat + r.intervalMs / r.limit - (r.intervalMs / r.limit) * r.burst;
        const at = eligible - base;
        const trace: TraceOp[] = [
          {
            at: 0,
            op: 'acquire',
            request: { rules: [r], costs: Array<number>(r.burst).fill(1) },
          },
          ...[at - 0.001, at, at + 0.001].map((at) => ({
            at,
            op: 'acquire' as const,
            request: { rules: [r], costs: [1] },
          })),
        ];
        const result = await runRedisTrace(
          url,
          trace,
          packageDir,
          prefix(),
          base,
        );
        expect(result.results).toEqual(runModelTrace(trace, base));
      }
    });
    it('matches generated scoped/lease/control traces (30 cases)', async () => {
      const rules: NormalizedRule[] = [
        { ...rule, name: 'tenant', scope: 'tenant', key: 'named:tenant' },
        {
          algorithm: 'fixed-window',
          intervalMs: 100,
          limit: 4,
          burst: 1,
          name: 'all',
          key: 'named:all',
        },
      ];
      const arbitrary = fc.array(
        fc.record({
          gap: fc.constantFrom(0, 0.001, 10, 29.999, 30, 100),
          kind: fc.integer({ min: 0, max: 4 }),
          identities: fc.array(fc.constantFrom('a', 'b', 'c'), {
            minLength: 1,
            maxLength: 4,
          }),
          cost: fc.integer({ min: 1, max: 3 }),
        }),
        { minLength: 2, maxLength: 15 },
      );
      for (const events of fc.sample(arbitrary, { seed: 812, numRuns: 30 })) {
        let at = 0;
        const trace: TraceOp[] = events.map((event, index) => {
          at += event.gap;
          if (event.kind === 0) return { at, op: 'pause', ms: 30.1 };
          if (event.kind === 1)
            return {
              at,
              op: 'renew',
              ttlMs: 100,
              tokens: [`owner-${Math.max(0, index - 1)}:0`],
            };
          if (event.kind === 2)
            return {
              at,
              op: 'release',
              tokens: [`owner-${Math.max(0, index - 1)}:0`],
            };
          return {
            at,
            op: 'scoped',
            request: {
              rules,
              jobs: event.identities.map((tenant) => ({
                cost: event.cost,
                scopes: { tenant },
              })),
              lease: { limit: 2, ttlMs: 30, owner: `owner-${index}` },
            },
          };
        });
        await parity(url, trace);
      }
    });
    it('matches sparse shared/global rules, independent identities and denials that skip', async () => {
      const rules = [
        { ...rule, name: 'tenant', scope: 'tenant', key: 'named:tenant' },
        { ...rule, name: 'all', key: 'named:all', burst: 5 },
      ];
      const jobs = [
        { cost: 3, scopes: { tenant: 'a:/☃' } },
        { cost: 1, scopes: { tenant: 'a:/☃' } },
        { cost: 1, scopes: { tenant: 'b' } },
      ];
      await parity(
        url,
        [0, 24.999, 25, 25.001, 99.999, 100, 125].map((at) => ({
          at,
          op: 'scoped',
          request: { rules, jobs },
        })),
      );
    });
    it('matches static leases at expiry equality, renewal, partial loss and release', async () => {
      const lease = { limit: 2, ttlMs: 30, owner: 'a' };
      await parity(url, [
        {
          at: 0,
          op: 'acquire',
          request: { rules: [rule], costs: [1, 1, 1], lease },
        },
        { at: 10, op: 'renew', tokens: ['a:0', 'missing'], ttlMs: 100 },
        {
          at: 29.999,
          op: 'acquire',
          request: {
            rules: [rule],
            costs: [1],
            lease: { ...lease, owner: 'b' },
          },
        },
        {
          at: 30,
          op: 'acquire',
          request: {
            rules: [rule],
            costs: [1, 1],
            lease: { ...lease, owner: 'c' },
          },
        },
        { at: 31, op: 'release', tokens: ['a:0'] },
        {
          at: 31,
          op: 'acquire',
          request: {
            rules: [rule],
            costs: [1],
            lease: { ...lease, owner: 'd' },
          },
        },
        { at: 110, op: 'renew', tokens: ['c:0'], ttlMs: 30 },
      ]);
    });
    it('matches scoped earliest-slot attribution including the documented memory divergence', async () => {
      const rules = [
          { ...rule, name: 'tenant', scope: 'tenant', key: 'named:tenant' },
        ],
        lease = { limit: 2, ttlMs: 30, owner: 'a' };
      await parity(url, [
        {
          at: 0,
          op: 'scoped',
          request: {
            rules,
            jobs: [{ cost: 1, scopes: { tenant: 'a' } }],
            lease,
          },
        },
        { at: 1, op: 'renew', tokens: ['a:0'], ttlMs: 200 },
        {
          at: 10,
          op: 'scoped',
          request: {
            rules,
            jobs: [
              { cost: 1, scopes: { tenant: 'b' } },
              { cost: 1, scopes: { tenant: 'c' } },
            ],
            lease: { ...lease, owner: 'b' },
          },
        },
        {
          at: 40,
          op: 'scoped',
          request: {
            rules,
            jobs: [{ cost: 1, scopes: { tenant: 'b' } }],
            lease: { ...lease, owner: 'c' },
          },
        },
      ]);
    });
    it('matches extending fractional pauses, static short-circuit, scoped max hints and ties', async () => {
      const rules = [
        { ...rule, name: 'tenant', scope: 'tenant', key: 'named:tenant' },
      ];
      await parity(url, [
        { at: 0.9, op: 'pause', ms: 30.1 },
        { at: 1, op: 'pause', ms: 1 },
        { at: 1.1, op: 'acquire', request: { rules: [rule], costs: [1] } },
        { at: 31, op: 'acquire', request: { rules: [rule], costs: [1] } },
      ]);
      await parity(url, [
        {
          at: 0,
          op: 'scoped',
          request: {
            rules,
            jobs: [{ cost: 3, scopes: { tenant: 'a' } }],
            lease: { limit: 1, ttlMs: 30, owner: 'a' },
          },
        },
        { at: 0, op: 'pause', ms: 30 },
        {
          at: 0,
          op: 'scoped',
          request: {
            rules,
            jobs: [
              { cost: 1, scopes: { tenant: 'a' } },
              { cost: 1, scopes: { tenant: 'b' } },
            ],
            lease: { limit: 1, ttlMs: 30, owner: 'b' },
          },
        },
        { at: 0, op: 'pause', ms: 40 },
        {
          at: 0,
          op: 'scoped',
          request: {
            rules,
            jobs: [{ cost: 1, scopes: { tenant: 'a' } }],
            lease: { limit: 1, ttlMs: 30, owner: 'c' },
          },
        },
      ]);
    });
    it.each(['gcra-one', 'gcra-burst', 'fixed-window', 'multi'] as const)(
      'replays exact ideal times and denies each constrained grant moved 1us earlier: %s',
      async (kind) => {
        const gcra = {
          ...rule,
          limit: 1,
          burst: kind === 'gcra-burst' ? 3 : 1,
        };
        const fixed: NormalizedRule = {
          algorithm: 'fixed-window',
          intervalMs: 200,
          limit: 1,
          burst: 1,
          key: 'fixed-window:200',
        };
        const rules =
          kind === 'fixed-window'
            ? [fixed]
            : kind === 'multi'
              ? [gcra, fixed]
              : [gcra];
        const io = new Redis(url);
        assertDisposableUrl(url);
        const time = await io.time();
        await io.quit();
        const base = (Math.ceil(Number(time[0]) / 1000) + 2) * 1000000;
        const state = createState(),
          seedCosts = Array<number>(kind === 'gcra-burst' ? 3 : 1).fill(1);
        acquire(state, { rules, costs: seedCosts }, base);
        const bound = idealBound({
          rules,
          initialState: state,
          t0: base,
          t1: base + 600,
          prefix: true,
          demand: { saturated: { cost: 1 } },
        });
        expect(bound.grants.length).toBeGreaterThan(0);
        const seed: TraceOp = {
          at: 0,
          op: 'acquire',
          request: { rules, costs: seedCosts },
        };
        const grants: TraceOp[] = bound.grants.map((g) => ({
          at: g.at - base,
          op: 'acquire',
          request: { rules, costs: [1] },
        }));
        const replay = await runRedisTrace(
          url,
          [seed, ...grants],
          packageDir,
          prefix(),
          base,
        );
        expect(
          replay.results
            .slice(1)
            .every((r) => (r as { granted: number }).granted === 1),
        ).toBe(true);
        for (let i = 0; i < grants.length; i++) {
          const moved = { ...grants[i]!, at: grants[i]!.at - 0.001 };
          const early = await runRedisTrace(
            url,
            [seed, ...grants.slice(0, i), moved],
            packageDir,
            prefix(),
            base,
          );
          expect(early.results.at(-1)).toMatchObject({
            granted: 0,
            retryAfterMs: 1,
          });
        }
      },
    );
    it.each(['weighted', 'lease'] as const)(
      'replays and proves constrained %s bound times against Lua',
      async (kind) => {
        const io = new Redis(url);
        const time = await io.time();
        await io.quit();
        const base = (Math.ceil(Number(time[0]) / 1000) + 2) * 1000000;
        const rules: NormalizedRule[] =
          kind === 'weighted'
            ? [{ ...rule, intervalMs: 100, limit: 10, burst: 3 }]
            : [];
        const lease =
          kind === 'lease' ? { limit: 1, ttlMs: 30, owner: 'seed' } : undefined;
        const state = createState();
        const seedRequest = {
          rules,
          costs: [kind === 'weighted' ? 3 : 1],
          ...(lease ? { lease } : {}),
        };
        acquire(state, seedRequest, base);
        const cost = kind === 'weighted' ? 2 : 1;
        const bound = idealBound({
          rules,
          ...(lease ? { lease } : {}),
          initialState: state,
          t0: base,
          t1: base + 101,
          prefix: true,
          demand: { saturated: { cost } },
        });
        expect(bound.admittedJobs).toBe(kind === 'weighted' ? 5 : 3);
        const seed: TraceOp = { at: 0, op: 'acquire', request: seedRequest };
        const grants: TraceOp[] = bound.grants.map((g, i) => ({
          at: g.at - base,
          op: 'acquire',
          request: {
            rules,
            costs: [cost],
            ...(lease ? { lease: { ...lease, owner: `grant-${i}` } } : {}),
          },
        }));
        const replay = await runRedisTrace(
          url,
          [seed, ...grants],
          packageDir,
          prefix(),
          base,
        );
        expect(
          replay.results
            .slice(1)
            .every((r) => (r as { granted: number }).granted === 1),
        ).toBe(true);
        for (let i = 0; i < grants.length; i++) {
          const early = await runRedisTrace(
            url,
            [
              seed,
              ...grants.slice(0, i),
              { ...grants[i]!, at: grants[i]!.at - 0.001 },
            ],
            packageDir,
            prefix(),
            base,
          );
          expect(early.results.at(-1)).toMatchObject({
            granted: 0,
            retryAfterMs: 1,
          });
        }
      },
    );
    it('exposes renew trailing-clock artifact without changing the shipped loop', async () => {
      assertDisposableUrl(url);
      const io = new Redis(url),
        key = `${prefix()}:leases`;
      try {
        const time = await io.time(),
          now = Number(time[0]) * 1000 + Number(time[1]) / 1000 + 60000;
        await io.zadd(key, now + 100, 'owner:0');
        const source = withInjectedClock(
          loadScripts(packageDir).RENEW.source,
        ).source;
        expect(await io.eval(source, 1, key, 100, 'owner:0', now)).toBe(0);
        expect(Number(await io.zscore(key, 'owner:0'))).toBe(now + 100);
      } finally {
        await io.unlink(key);
        await io.quit();
      }
    });
  });
if (!urls.length)
  describe.skip('model Redis parity (set PERF_REDIS_URLS or PERF_INTEGRATION=1)', () => {
    it('requires explicit disposable endpoints', () => {});
  });
