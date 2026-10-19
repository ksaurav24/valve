// Pure admission, capacity, and abstract-client self-tests; no production scheduler claims.
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  acquire,
  acquireScoped,
  pause,
  release,
  renew,
} from '../src/model/admission.ts';
import { createState, cloneState, expire } from '../src/model/state.ts';
import type { Rule } from '../src/model/state.ts';
import { idealBound, ruleCapacity } from '../src/model/capacity.ts';
import { simulate } from '../src/model/sim.ts';
const gcra: Rule = { algorithm: 'gcra', limit: 2, intervalMs: 10, burst: 2 };
const fixed: Rule = {
  algorithm: 'fixed-window',
  limit: 2,
  intervalMs: 10,
  burst: 1,
};
describe('Lua admission state', () => {
  it('grants prefixes, rounds hints and admits at exact fractional eligibility', () => {
    const state = createState();
    expect(acquire(state, { rules: [gcra], costs: [1, 1, 1] }, 100)).toEqual({
      granted: 2,
      retryAfterMs: 5,
      pausedMs: 0,
    });
    expect(
      acquire(state, { rules: [gcra], costs: [1] }, 104.999).retryAfterMs,
    ).toBe(1);
    expect(acquire(state, { rules: [gcra], costs: [1] }, 105).granted).toBe(1);
  });
  it('spends several rules atomically and blocks weighted heads', () => {
    const state = createState();
    acquire(state, { rules: [gcra, fixed], costs: [1] }, 100);
    expect(
      acquire(state, { rules: [gcra, fixed], costs: [2, 1] }, 100).granted,
    ).toBe(0);
    expect(
      acquire(state, { rules: [gcra, fixed], costs: [1] }, 100).granted,
    ).toBe(1);
  });
  it('retains ceil(TAT), static two-interval TTL and scoped next-window TTL', () => {
    const state = createState();
    acquire(state, { rules: [gcra, fixed], costs: [1] }, 100.25);
    expect(state.rules.get('0')?.expiresAt).toBe(106);
    expect(state.rules.get('1')?.expiresAt).toBe(120);
    const scoped = createState();
    acquireScoped(
      scoped,
      { rules: [fixed], jobs: [{ cost: 1, refs: [0] }] },
      100.25,
    );
    expect(scoped.rules.get('0')?.expiresAt).toBe(110);
    expire(scoped, 110);
    expect(scoped.rules.size).toBe(0);
  });
  it('skips denied scoped jobs and isolates identities', () => {
    const rules = [
        { ...gcra, key: 'a' },
        { ...gcra, key: 'b' },
      ],
      state = createState();
    const result = acquireScoped(
      state,
      {
        rules,
        jobs: [
          { cost: 2, refs: [0] },
          { cost: 1, refs: [0] },
          { cost: 1, refs: [1] },
        ],
      },
      100,
    );
    expect(result.grantedIndexes).toEqual([0, 2]);
    expect(result.blocked).toEqual([{ index: 1, retryAfterMs: 5 }]);
  });
  it('checks static lease before rates and uses earliest pre-call lease', () => {
    const state = createState(),
      lease = { limit: 1, ttlMs: 30, owner: 'a' };
    expect(
      acquire(state, { rules: [gcra], costs: [2, 2], lease }, 100),
    ).toMatchObject({
      granted: 1,
      retryAfterMs: 30,
      leaseBlocked: true,
      tokens: ['a:0'],
    });
    expect(renew(state, ['a:0'], 50, 110)).toBe(true);
    expect(renew(state, ['a:0'], 50, 160)).toBe(false);
    expect(acquire(state, { rules: [], costs: [1], lease }, 160).granted).toBe(
      1,
    );
    release(state, ['a:0'], 160);
    expect(state.leases.size).toBe(0);
  });
  it('scoped leaseBlocked is equality with max retry, including ties and pause', () => {
    const state = createState(),
      lease = { limit: 1, ttlMs: 30, owner: 'a' };
    acquire(state, { rules: [], costs: [1], lease }, 100);
    pause(state, 40, 100);
    const reply = acquireScoped(
      state,
      {
        rules: [gcra],
        jobs: [{ cost: 1, refs: [0] }],
        lease: { ...lease, owner: 'b' },
      },
      100,
    );
    expect(reply.blocked).toEqual([
      { index: 0, retryAfterMs: 40, leaseBlocked: false },
    ]);
  });
  it('pause extends only and uses integer Redis PTTL snapshots', () => {
    const state = createState();
    pause(state, 10.1, 100.9);
    pause(state, 1, 101);
    expect(acquire(state, { rules: [], costs: [1] }, 101.9).pausedMs).toBe(10);
    expect(acquire(state, { rules: [], costs: [1] }, 111).granted).toBe(1);
  });
});
describe('capacity and ideal supply', () => {
  it('separates long-run rate from burst and aligned window supply', () => {
    expect(ruleCapacity([gcra, fixed], 100)).toBe(20);
    expect(
      ruleCapacity([gcra], 100, {
        lease: { limit: 1, meanDurationMs: 20 },
        cost: 2,
      }),
    ).toBe(10);
    expect(
      idealBound({
        rules: [fixed],
        t0: 9.999,
        t1: 10.001,
        prefix: true,
        demand: { saturated: { cost: 1 } },
      }).admittedJobs,
    ).toBe(4);
  });
  it('matches the GCRA ceil(T/step)+burst-1 window invariant', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 8 }),
        fc.integer({ min: 1, max: 8 }),
        fc.integer({ min: 1, max: 30 }),
        fc.integer({ min: 1, max: 8 }),
        (step, burst, time, limit) => {
          const result = idealBound({
            rules: [
              { algorithm: 'gcra', intervalMs: step * limit, limit, burst },
            ],
            t0: 100,
            t1: 100 + time,
            prefix: false,
            demand: { saturated: { cost: 1 } },
          });
          expect(result.admittedJobs).toBe(Math.ceil(time / step) + burst - 1);
          expect(
            idealBound({
              rules: [
                { algorithm: 'gcra', intervalMs: step * limit, limit, burst },
              ],
              t0: 100,
              t1: 100 + step * limit,
              prefix: false,
              demand: { saturated: { cost: 1 } },
            }).admittedJobs,
          ).toBe(limit + burst - 1);
        },
      ),
      { numRuns: 100 },
    );
  });
  it('matches exhaustive unit-cost integer-grid schedules for small multi-rule cases', () => {
    for (const limit of [1, 2])
      for (const burst of [1, 2]) {
        const rules: Rule[] = [
          { algorithm: 'gcra', intervalMs: 4, limit, burst },
          { ...fixed, intervalMs: 6 },
        ];
        function brute(
          t: number,
          state: ReturnType<typeof createState>,
        ): number {
          if (t === 108) return 0;
          let best = brute(t + 1, cloneState(state));
          let count = 0;
          while (acquire(state, { rules, costs: [1] }, t).granted) {
            count++;
            best = Math.max(best, count + brute(t + 1, cloneState(state)));
          }
          return best;
        }
        expect(
          idealBound({
            rules,
            t0: 100,
            t1: 108,
            prefix: true,
            demand: { saturated: { cost: 1 } },
          }).admittedJobs,
        ).toBe(brute(100, createState()));
      }
  });
  it('uses measured state, known lease completions, and independent scope keys', () => {
    const initialState = createState();
    initialState.leases.set('crashed', 105);
    expect(
      idealBound({
        rules: [],
        lease: { limit: 1, ttlMs: 30 },
        initialState,
        t0: 100,
        t1: 111,
        prefix: true,
        demand: { saturated: { cost: 1, durationMs: 2 } },
      }).grants.map((g) => g.at),
    ).toEqual([105, 107, 109]);
    expect(initialState.leases.size).toBe(1);
    const result = idealBound({
      rules: [gcra],
      t0: 100,
      t1: 101,
      prefix: false,
      demand: {
        arrivals: ['a', 'b', 'a'].map((key) => ({
          at: 100,
          cost: 2,
          scopeKeys: [key],
        })),
      },
    });
    expect(result.admittedCost).toBe(4);
  });
  it('computes lease and scoped score-rounding events without polling', () => {
    const t0 = 1792383000000,
      state = createState();
    state.leases.set('a:0', t0 + 30.004);
    const result = idealBound({
      rules: [gcra],
      lease: { limit: 1, ttlMs: 30 },
      initialState: state,
      t0,
      t1: t0 + 31,
      prefix: false,
      demand: { arrivals: [{ at: t0, cost: 1, scopeKeys: ['b'] }] },
    });
    expect(result.admittedJobs).toBe(1);
    expect(result.grants[0]!.at).toBe(t0 + 30.004);
    expect(result.grants[0]!.at).toBeLessThan(t0 + 30.1);
  });
  it('refills after idle and counts only starts in the half-open observation window', () => {
    const result = idealBound({
      rules: [gcra],
      t0: 100,
      t1: 201,
      prefix: true,
      demand: {
        arrivals: [
          { at: 99, cost: 2 },
          { at: 200, cost: 2 },
          { at: 201, cost: 1 },
        ],
      },
    });
    expect(result.grants).toEqual([
      { at: 100, cost: 2 },
      { at: 200, cost: 2 },
    ]);
  });
  it('reports weighted FIFO head-of-line loss', () => {
    const state = createState();
    acquire(state, { rules: [gcra], costs: [1] }, 100);
    const result = idealBound({
      rules: [gcra],
      initialState: state,
      t0: 100,
      t1: 101,
      prefix: true,
      demand: {
        arrivals: [
          { at: 100, cost: 2 },
          { at: 100, cost: 1 },
        ],
      },
    });
    expect(result.admittedCost).toBe(0);
    expect(result.headOfLineLossCost).toBe(1);
  });
});
describe('declared abstract clients', () => {
  it('is deterministic, labelled, and reconciles abstract-client counts', () => {
    const input = {
      clients: 2,
      queue: { backlog: 3 },
      rules: [gcra],
      policy: {
        batch: 2,
        retry: 'hint' as const,
        rttMs: { kind: 'fixed' as const, ms: 1 },
        timerLateness: { kind: 'uniform' as const, minMs: 0, maxMs: 1 },
        oneInFlight: true as const,
      },
      seed: 42,
      t0: 100,
      t1: 200,
    };
    const result = simulate(input);
    expect(result).toEqual(simulate(input));
    expect(result.kind).toBe('abstract-client-model');
    expect(result.grants).toBe(result.waits.length);
    expect(result.callsPerGrant).toBe(result.calls / result.grants);
    expect(result.perClientGrants.reduce((a, b) => a + b, 0)).toBe(
      result.grants,
    );
  });
  it('honors open-loop arrivals and one call in flight', () => {
    const result = simulate({
      clients: 1,
      queue: { arrivals: [[100, 103, 110]] },
      rules: [],
      policy: {
        batch: 2,
        retry: 'hint',
        rttMs: { kind: 'fixed', ms: 5 },
        timerLateness: { kind: 'fixed', ms: 0 },
        oneInFlight: true,
      },
      seed: 1,
      t0: 100,
      t1: 120,
    });
    expect(result.grants).toBe(3);
    expect(result.waits).toEqual([0, 2, 0]);
  });
});
