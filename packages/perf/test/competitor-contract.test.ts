import { expect, it } from 'vitest';
import { competitorContract } from '../src/oracle/competitor.ts';
import { CATEGORIES } from '../src/adapters/registry.ts';
import { seedFor } from '../src/supervisor/runner.ts';
import { Outcome, type CellSpec, type JobRecord } from '../src/core/types.ts';
const job = (st: number): JobRecord => ({
  w: 0,
  i: st,
  k: 0,
  ia: st,
  sa: st,
  st,
  en: st + 1,
  o: Outcome.completed,
  c: 1,
  mw: -1,
  ab: -1,
  rp: -1,
  sd: st,
  sdStart: st,
});
it('pairs the same seeded workload across libraries and keeps separate local categories', () => {
  const base = {
    ...CATEGORIES[0]!.buildCell(),
    suite: 'libs',
    id: 'libs/L1/valve',
  };
  expect(seedFor(42, base, 3)).toBe(
    seedFor(42, { ...base, id: 'libs/L1/p-limit', library: 'p-limit' }, 3),
  );
  expect(seedFor(42, base, 3)).not.toBe(
    seedFor(42, { ...base, id: 'libs/L1-noop/valve' }, 3),
  );
});
it('flags gross observable pacing violations while withholding exact quota proof', () => {
  const cell = CATEGORIES.find((c) => c.id === 'L2')!.buildCell({
    library: 'p-queue',
    rules: [{ limit: 100, intervalMs: 1000 }],
  });
  expect(competitorContract(cell, [job(100), job(101)])).toMatchObject({
    violations: [{ class: 'contract' }],
    unverified: ['rate-bound'],
  });
  expect(competitorContract(cell, [job(100), job(110)])).toMatchObject({
    violations: [],
    unverified: ['rate-bound'],
  });
});
it('checks two-window envelopes without assuming Valve window anchoring', () => {
  const cell: CellSpec = CATEGORIES.find((c) => c.id === 'L3')!.buildCell({
    library: 'bottleneck',
    rules: [{ limit: 2, intervalMs: 100, algorithm: 'fixed-window' }],
  });
  expect(
    competitorContract(cell, [job(90), job(91), job(100), job(101)]).violations,
  ).toHaveLength(0);
  expect(
    competitorContract(
      cell,
      Array.from({ length: 5 }, (_, i) => job(i)),
    ).violations,
  ).toMatchObject([{ class: 'contract' }]);
  expect(
    competitorContract(
      { ...cell, library: 'identity' },
      Array.from({ length: 10 }, (_, i) => job(i)),
    ).violations,
  ).toEqual([]);
});
