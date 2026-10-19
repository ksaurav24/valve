// NumPy golden percentiles and conservative failure-rank invariants.
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import golden from './fixtures/golden-stats.json' with { type: 'json' };
import {
  conditionalPercentiles,
  failureRanked,
  quantile,
} from '../src/analyze/quantile.ts';
import type { QuantileMethod } from '../src/analyze/quantile.ts';

describe('quantiles', () => {
  it('matches NumPy linear, lower, and inverted_cdf conventions', () => {
    for (const row of golden.quantiles) {
      expect(
        Math.abs(
          quantile(row.sorted, row.q, row.method as QuantileMethod) - row.value,
        ),
      ).toBeLessThanOrEqual(1e-12);
    }
  });
  it('is monotone in q for every convention', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -10000, max: 10000 }), {
          minLength: 1,
          maxLength: 100,
        }),
        fc.integer({ min: 0, max: 1000 }),
        fc.integer({ min: 0, max: 1000 }),
        (values, a, b) => {
          const sorted = values.sort((x, y) => x - y);
          for (const method of ['linear', 'lower', 'nearest-rank'] as const) {
            expect(
              quantile(sorted, Math.min(a, b) / 1000, method),
            ).toBeLessThanOrEqual(
              quantile(sorted, Math.max(a, b) / 1000, method),
            );
          }
        },
      ),
    );
  });
  it('labels conditional percentiles and empty data explicitly', () => {
    expect(conditionalPercentiles([4, 1, 2, 3], [0.5, 1])).toEqual({
      p50: 2.5,
      p100: 4,
    });
    expect(conditionalPercentiles([], [0.5])).toEqual({ p50: null });
    expect(quantile([], 0.5)).toBeNaN();
    expect(() => quantile([1], -0.1)).toThrow(RangeError);
    expect(() => conditionalPercentiles([], [2])).toThrow(RangeError);
  });
  it('places all non-starts after finite waits without interpolation', () => {
    expect(failureRanked([30, 10], 2, 0)).toBe(10);
    expect(failureRanked([30, 10], 2, 0.5)).toBe(30);
    expect(failureRanked([30, 10], 2, 0.5001)).toBe('failure');
    expect(failureRanked([30, 10], 2, 1)).toBe('failure');
    expect(failureRanked([], 2, 0)).toBe('failure');
    expect(failureRanked([], 0, 0.5)).toBeNaN();
    expect(() => failureRanked([1], -1, 0.5)).toThrow(RangeError);
  });
});
