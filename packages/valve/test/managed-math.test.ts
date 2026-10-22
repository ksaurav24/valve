import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { memoryStore } from '../src/index.js';
import { normalize } from '../src/rules.js';

const intervalMs = 1024;
const power = fc.constantFrom(1, 2, 4, 8, 16, 32);
const burst = fc.constantFrom(8, 16, 32);
const steps = fc.array(
  fc.record({
    advance: fc.integer({ min: 0, max: intervalMs }),
    limit: fc.option(power, { nil: undefined }),
    burst: fc.option(burst, { nil: undefined }),
    cost: fc.integer({ min: 1, max: 8 }),
  }),
  { minLength: 1, maxLength: 60 },
);

const rulesFor = (scoped: boolean) =>
  normalize({
    id: 'model',
    rate: {
      name: 'rate',
      ...(scoped ? { scope: 'account' } : {}),
      limit: 8,
      interval: intervalMs,
      burst: 8,
    },
    limits: 'managed',
  }).rules;

/** Independent cost-unit model: elapsed time drains debt at the old rate. */
function assertSequence(
  sequence: readonly {
    advance: number;
    limit: number | undefined;
    burst: number | undefined;
    cost: number;
  }[],
  scoped: boolean,
) {
  let now = 0;
  let last = 0;
  let debt = 0;
  let limit = 8;
  let capacity = 8;
  const store = memoryStore({ clock: () => now });
  const rules = rulesFor(scoped);
  const id = scoped ? 'property-scoped' : 'property-static';
  const drain = () => {
    debt = Math.max(0, debt - ((now - last) * limit) / intervalMs);
    last = now;
  };

  for (const step of sequence) {
    now += step.advance;
    drain();
    const patch: { limit?: number; burst?: number } = {};
    if (step.limit !== undefined) {
      limit = step.limit;
      patch.limit = step.limit;
    }
    if (step.burst !== undefined) {
      capacity = step.burst;
      patch.burst = step.burst;
    }
    if (patch.limit !== undefined || patch.burst !== undefined)
      store.managed!.updateLimits({
        id,
        rules,
        patch: { rate: patch },
      });

    const granted = debt + step.cost <= capacity;
    const retryAfterMs = granted
      ? 0
      : Math.ceil(((debt + step.cost - capacity) * intervalMs) / limit);
    if (granted) debt += step.cost;

    if (scoped) {
      const result = store.managed!.acquireScopedSync!({
        id,
        rules,
        jobs: [{ cost: step.cost, scopes: { account: 'always-touched' } }],
      });
      expect(result.grantedIndexes).toEqual(granted ? [0] : []);
      expect(result.blocked).toEqual(
        granted ? [] : [{ index: 0, retryAfterMs }],
      );
    } else {
      const result = store.managed!.acquireSync!({
        id,
        rules,
        costs: [step.cost],
      });
      expect(result).toMatchObject({
        granted: granted ? 1 : 0,
        retryAfterMs,
        impossible: false,
      });
    }
  }
}

describe('managed GCRA cost-unit model', () => {
  it.each([
    ['static rule', false, 24680],
    ['scoped identity touched on every step', true, 13579],
  ] as const)('matches the reference for a %s', (_name, scoped, seed) => {
    fc.assert(
      fc.property(steps, (sequence) => assertSequence(sequence, scoped)),
      { numRuns: 300, seed },
    );
  });

  it('documents cold expiry and exact hot-path extension after a rate decrease', async () => {
    const rules = rulesFor(true);

    let coldNow = 0;
    const cold = memoryStore({ clock: () => coldNow });
    expect(
      cold.managed!.acquireScopedSync!({
        id: 'cold',
        rules,
        jobs: [{ cost: 8, scopes: { account: 'A' } }],
      }).grantedIndexes,
    ).toEqual([0]);
    await cold.managed!.updateLimits({
      id: 'cold',
      rules,
      patch: { rate: { limit: 1 } },
    });
    coldNow = 1024;
    expect(
      cold.managed!.acquireScopedSync!({
        id: 'cold',
        rules,
        jobs: [{ cost: 1, scopes: { account: 'A' } }],
      }),
    ).toMatchObject({ grantedIndexes: [0], blocked: [] });

    let hotNow = 0;
    const hot = memoryStore({ clock: () => hotNow });
    expect(
      hot.managed!.acquireScopedSync!({
        id: 'hot',
        rules,
        jobs: [{ cost: 8, scopes: { account: 'A' } }],
      }).grantedIndexes,
    ).toEqual([0]);
    await hot.managed!.updateLimits({
      id: 'hot',
      rules,
      patch: { rate: { limit: 1 } },
    });
    hotNow = 1023;
    expect(
      hot.managed!.acquireScopedSync!({
        id: 'hot',
        rules,
        jobs: [{ cost: 1, scopes: { account: 'A' } }],
      }),
    ).toMatchObject({
      grantedIndexes: [],
      blocked: [{ index: 0, retryAfterMs: 1 }],
    });
    hotNow = 1024;
    expect(
      hot.managed!.acquireScopedSync!({
        id: 'hot',
        rules,
        jobs: [{ cost: 1, scopes: { account: 'A' } }],
      }),
    ).toMatchObject({ grantedIndexes: [0], blocked: [] });

    await Promise.all([cold.close(), hot.close()]);
  });
});
