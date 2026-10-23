// Independent golden references and invariants for replication statistics.
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import golden from './fixtures/golden-stats.json' with { type: 'json' };
import {
  benjaminiHochberg,
  holm,
  jain,
  mde,
  mean,
  pairedT,
  sd,
  signFlipTest,
  tQuantile,
} from '../src/analyze/stats.ts';

describe('reference statistics', () => {
  it('matches SciPy t quantiles to 1e-9 relative error', () => {
    for (const row of golden.tQuantiles) {
      const actual = tQuantile(row.p, row.df);
      // SciPy ppf(0.5) can leave a ~1e-17 solver residual; symmetry gives exactly zero.
      if (row.p === 0.5) {
        expect(Math.abs(row.value)).toBeLessThan(1e-14);
        expect(actual).toBe(0);
      } else
        expect(Math.abs((actual - row.value) / row.value)).toBeLessThanOrEqual(
          1e-9,
        );
    }
  });
  it('matches SciPy paired intervals and sample moments to 1e-9', () => {
    for (const row of golden.paired) {
      const actual = pairedT(row.diffs, row.alpha);
      expect(actual.n).toBe(row.n);
      expect(actual.df).toBe(row.df);
      for (const key of ['mean', 'sd', 'se', 'lo', 'hi'] as const) {
        expect(Math.abs(actual[key]! - row[key])).toBeLessThanOrEqual(1e-9);
      }
    }
  });
  it('matches exhaustive sign permutations and SciPy permutation_test', () => {
    for (const row of golden.signFlip)
      expect(signFlipTest(row.diffs)).toBe(row.p);
  });
  it('matches statsmodels Holm and BH adjustments', () => {
    for (const row of golden.multiplicity) {
      holm(row.pvalues).forEach((p, i) =>
        expect(p).toBeCloseTo(row.holm[i]!, 14),
      );
      benjaminiHochberg(row.pvalues).forEach((p, i) =>
        expect(p).toBeCloseTo(row.bh[i]!, 14),
      );
    }
  });
  it('matches the documented t-quantile MDE approximation', () => {
    for (const row of golden.mde)
      expect(Math.abs(mde(row) - row.value)).toBeLessThanOrEqual(1e-9);
  });
});

describe('edge cases and properties', () => {
  it('leaves intervals undefined below two pairs', () => {
    expect(pairedT([], 0.05)).toMatchObject({ n: 0, lo: null, hi: null });
    expect(pairedT([4], 0.05)).toMatchObject({
      n: 1,
      mean: 4,
      lo: null,
      hi: null,
    });
    expect(mean([])).toBeNaN();
    expect(sd([1])).toBeNaN();
    expect(pairedT([3, 3, 3], 0.05)).toMatchObject({
      sd: 0,
      se: 0,
      lo: 3,
      hi: 3,
    });
    expect(() => pairedT([1, 2], 0)).toThrow(RangeError);
  });
  it('uses reproducible Monte Carlo including the observed assignment', () => {
    const diffs = golden.signFlip.at(-1)!.diffs;
    const options = { exactUpTo: 0, iterations: 20_000, seed: 123 };
    const actual = signFlipTest(diffs, options);
    expect(actual).toBe(signFlipTest(diffs, options));
    expect(
      signFlipTest(
        [1, 2, -3, 4, 5, -6, 7, 8, -9, 10, 11, -12, 13, 14, -15, 16, 17],
        options,
      ),
    ).toBe(0.13979301034948252);
    expect(Math.abs(actual - signFlipTest(diffs))).toBeLessThan(0.025);
    expect(
      signFlipTest(Array<number>(17).fill(1), { iterations: 1, seed: 1 }),
    ).toBeGreaterThanOrEqual(0.5);
    expect(signFlipTest(Array<number>(17).fill(0), options)).toBe(1);
    expect(signFlipTest([])).toBe(1);
  });
  it('preserves multiplicity ordering and never reduces raw p-values', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 10000 }), { maxLength: 100 }),
        (integers) => {
          const raw = integers.map((p) => p / 10000).sort((a, b) => a - b);
          for (const adjusted of [holm(raw), benjaminiHochberg(raw)]) {
            adjusted.forEach((p, i) => {
              expect(p + 1e-15).toBeGreaterThanOrEqual(raw[i]!);
              expect(p).toBeLessThanOrEqual(1);
              if (i > 0) expect(p).toBeGreaterThanOrEqual(adjusted[i - 1]!);
            });
          }
        },
      ),
    );
    expect(holm([])).toEqual([]);
    expect(benjaminiHochberg([])).toEqual([]);
    expect(() => holm([-1])).toThrow(RangeError);
    expect(() => benjaminiHochberg([Number.NaN])).toThrow(RangeError);
  });
  it('has sign-flip symmetry and scale invariance', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -10, max: 10 }), {
          minLength: 1,
          maxLength: 8,
        }),
        (diffs) => {
          expect(signFlipTest(diffs.map((value) => -value))).toBe(
            signFlipTest(diffs),
          );
          expect(signFlipTest(diffs.map((value) => 3 * value))).toBe(
            signFlipTest(diffs),
          );
        },
      ),
    );
  });
  it('reports Jain fairness and handles undefined zero allocations', () => {
    expect(jain([2, 2, 2])).toBeCloseTo(1, 14);
    expect(jain([0, 0, 3])).toBeCloseTo(1 / 3, 14);
    expect(jain([1e200, 1e200])).toBe(1);
    expect(jain([])).toBeNaN();
    expect(jain([0, 0])).toBeNaN();
    expect(() => jain([-1])).toThrow(RangeError);
  });
});
