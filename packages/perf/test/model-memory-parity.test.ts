// The memory Store is an independent implementation, not the model's oracle.
import { expect, it } from 'vitest';
import fc from 'fast-check';
import type { NormalizedRule } from 'valvejs';
import {
  boundaryTimes,
  runMemoryTrace,
  runModelTrace,
  traceArbitrary,
} from '../src/model/parity.ts';
import { acquire, acquireScoped } from '../src/model/admission.ts';
import { createState } from '../src/model/state.ts';
import type { TraceOp } from '../src/model/parity.ts';
const rule: NormalizedRule = {
  algorithm: 'gcra',
  intervalMs: 100,
  limit: 4,
  burst: 3,
  key: 'gcra:100',
};
it.each(['gcra', 'fixed-window', 'multi'] as const)(
  'matches integer-ms %s traces',
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
                key: 'fixed-window:100',
              },
            ];
    await fc.assert(
      fc.asyncProperty(
        traceArbitrary(rules).map((trace) =>
          trace.map((e) => ({ ...e, at: Math.floor(e.at) })),
        ),
        async (trace) => {
          expect(await runMemoryTrace(trace, 100000)).toEqual(
            runModelTrace(trace, 100000),
          );
        },
      ),
      { numRuns: 100, seed: 123 },
    );
  },
);
it('matches scoped identities, leases, renewal, release and integer pause', async () => {
  const rules = [
    { ...rule, name: 'tenant', scope: 'tenant', key: 'named:tenant' },
  ];
  const request = {
    rules,
    jobs: [
      { cost: 3, scopes: { tenant: 'a' } },
      { cost: 1, scopes: { tenant: 'a' } },
      { cost: 1, scopes: { tenant: 'b' } },
    ],
  };
  const trace: TraceOp[] = [
    { at: 0, op: 'scoped', request },
    { at: 25, op: 'scoped', request },
    { at: 30, op: 'pause', ms: 10 },
    { at: 30, op: 'scoped', request },
    { at: 40, op: 'scoped', request },
  ];
  expect(await runMemoryTrace(trace, 100000)).toEqual(
    runModelTrace(trace, 100000),
  );
  const leaseTrace: TraceOp[] = [
    {
      at: 0,
      op: 'acquire',
      request: {
        rules: [],
        costs: [1, 1],
        lease: { limit: 1, ttlMs: 30, owner: 'a' },
      },
    },
    { at: 10, op: 'renew', tokens: ['a:0'], ttlMs: 50 },
    { at: 60, op: 'renew', tokens: ['a:0'], ttlMs: 50 },
    { at: 60, op: 'release', tokens: ['a:0'] },
  ];
  expect(await runMemoryTrace(leaseTrace)).toEqual(runModelTrace(leaseTrace));
});
it('documents scoped lease retry divergence: Lua excludes same-call new slots from earliest', async () => {
  const rules = [
    { ...rule, name: 'tenant', scope: 'tenant', key: 'named:tenant' },
  ];
  const lease = { limit: 2, ttlMs: 30, owner: 'a' };
  const trace: TraceOp[] = [
    {
      at: 0,
      op: 'scoped',
      request: { rules, jobs: [{ cost: 1, scopes: { tenant: 'a' } }], lease },
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
  ];
  const model = runModelTrace(trace),
    memory = await runMemoryTrace(trace);
  expect(model[2]).toMatchObject({
    grantedIndexes: [0],
    blocked: [{ index: 1, retryAfterMs: 191, leaseBlocked: true }],
  });
  expect(memory[2]).toMatchObject({
    grantedIndexes: [0],
    blocked: [{ index: 1, retryAfterMs: 30, leaseBlocked: true }],
  });
});
it('documents fractional pause rounding divergence and covers fractional GCRA expiry without decision divergence', async () => {
  const trace: TraceOp[] = [
    { at: 0.9, op: 'pause', ms: 1.1 },
    { at: 1.1, op: 'acquire', request: { rules: [], costs: [1] } },
  ];
  expect(runModelTrace(trace)[1]).toMatchObject({ pausedMs: 1 });
  expect((await runMemoryTrace(trace))[1]).toMatchObject({ pausedMs: 1 });
  const different: TraceOp[] = [
    { at: 0.9, op: 'pause', ms: 1 },
    { at: 1.1, op: 'acquire', request: { rules: [], costs: [1] } },
  ];
  expect(runModelTrace(different)[1]).toMatchObject({
    granted: 1,
    pausedMs: 0,
  });
  expect((await runMemoryTrace(different))[1]).toMatchObject({
    granted: 0,
    pausedMs: 1,
  });
  const expiryTrace: TraceOp[] = boundaryTimes(125.5, rule).map((at) => ({
    at,
    op: 'acquire',
    request: { rules: [rule], costs: [1] },
  }));
  expect(await runMemoryTrace(expiryTrace, 100000)).toEqual(
    runModelTrace(expiryTrace, 100000),
  );
});

it('documents epoch-scale scoped Lua score-bound rounding (integer expiry still matches)', async () => {
  const base = 1792383000000;
  const rules = [
    { ...rule, name: 'tenant', scope: 'tenant', key: 'named:tenant' },
  ];
  const lease = { limit: 1, ttlMs: 30, owner: 'a' };
  const trace: TraceOp[] = [
    {
      at: 0.004,
      op: 'scoped',
      request: { rules, jobs: [{ cost: 1, scopes: { tenant: 'a' } }], lease },
    },
    {
      at: 30.004,
      op: 'scoped',
      request: {
        rules,
        jobs: [{ cost: 1, scopes: { tenant: 'b' } }],
        lease: { ...lease, owner: 'b' },
      },
    },
  ];
  expect(runModelTrace(trace, base)[1]).toMatchObject({
    grantedIndexes: [],
    blocked: [{ index: 0, retryAfterMs: 1, leaseBlocked: true }],
  });
  expect((await runMemoryTrace(trace, base))[1]).toMatchObject({
    grantedIndexes: [0],
    blocked: [],
  });
});

it('asserts the documented expiry formula differences and their decision equivalence', async () => {
  const now = 1000.25;
  const gcra: NormalizedRule = {
    algorithm: 'gcra',
    intervalMs: 1,
    limit: 2,
    burst: 1,
    key: 'gcra:1',
  };
  const state = createState();
  acquire(state, { rules: [gcra], costs: [1] }, now);
  const tat = now + 0.5;
  expect(state.rules.get(gcra.key)?.expiresAt).toBe(Math.ceil(tat));
  const memoryExpiry = now + Math.max(1, Math.ceil(tat - now));
  expect(memoryExpiry).toBe(1001.25);
  expect(memoryExpiry).not.toBe(state.rules.get(gcra.key)?.expiresAt);
  const fixed: NormalizedRule = {
    ...gcra,
    algorithm: 'fixed-window',
    limit: 1,
    key: 'named:tenant',
    name: 'tenant',
    scope: 'tenant',
  };
  acquireScoped(state, { rules: [fixed], jobs: [{ cost: 1, refs: [0] }] }, now);
  expect(state.rules.get(fixed.key)?.expiresAt).toBe(1001);
  expect(now + Math.ceil(2 * fixed.intervalMs)).toBe(1002.25);
  const trace: TraceOp[] = [0.25, 0.749, 0.75, 0.999, 1, 1.249, 1.25].map(
    (at) => ({ at, op: 'acquire', request: { rules: [gcra], costs: [1] } }),
  );
  expect(await runMemoryTrace(trace, 1000)).toEqual(runModelTrace(trace, 1000));
  const scoped: TraceOp[] = [0.25, 0.999, 1, 1.25, 2].map((at) => ({
    at,
    op: 'scoped',
    request: { rules: [fixed], jobs: [{ cost: 1, scopes: { tenant: 'a' } }] },
  }));
  expect(await runMemoryTrace(scoped, 1000)).toEqual(
    runModelTrace(scoped, 1000),
  );
});
