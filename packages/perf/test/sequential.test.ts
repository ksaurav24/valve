// Preregistered staged decision boundaries and A/A calibration checks.
import { describe, expect, it } from 'vitest';
import {
  aaVerdict,
  alphaPerLook,
  shouldStop,
  verdictFor,
} from '../src/analyze/sequential.ts';
import type {
  DecisionMetric,
  DecisionPlan,
  PerfVerdict,
} from '../src/core/types.ts';

const metric: DecisionMetric = {
  metric: 'throughput',
  better: 'higher',
  margin: 1,
};
const plan: DecisionPlan = {
  metrics: [metric],
  looks: [5, 10, 20],
  alpha: 0.05,
};
const input = (
  diffs: number[],
  options: Partial<{
    metric: DecisionMetric;
    baseMean: number;
    isFinalLook: boolean;
  }> = {},
) => ({
  diffs,
  metric,
  baseMean: 10,
  plan,
  isFinalLook: false,
  ...options,
});

describe('staged decisions', () => {
  it('splits the two-sided error budget equally across preregistered looks', () => {
    expect(alphaPerLook(plan)).toBe(0.05 / 3);
    expect(() => alphaPerLook({ ...plan, looks: [] })).toThrow(RangeError);
  });
  it.each<[number[], PerfVerdict]>([
    [[-2, -2, -2, -2, -2], 'REGRESSION'],
    [[2, 2, 2, 2, 2], 'IMPROVEMENT'],
    [[-0.1, 0, 0.1, 0, 0], 'EQUIVALENT'],
    [[0.4, 0.6, 0.8, 1, 1.2], 'NONINFERIOR'],
    [[-3, -1, 0, 1, 3], 'INCONCLUSIVE'],
    [[-1, -1, -1, -1, -1], 'INCONCLUSIVE'],
    [[1, 1, 1, 1, 1], 'NONINFERIOR'],
  ])('classifies %j as %s with strict boundaries', (diffs, verdict) => {
    const result = verdictFor(input(diffs));
    expect(result.verdict).toBe(verdict);
    expect(result.n).toBe(5);
    expect(result.reason.length).toBeGreaterThan(0);
    expect(verdictFor(input(diffs, { isFinalLook: true })).verdict).toBe(
      verdict,
    );
  });
  it('reports descriptive differences without an interval below five replications', () => {
    for (const diffs of [[], [1], [1, 1], [1, 1, 1, 1]]) {
      expect(verdictFor(input(diffs))).toMatchObject({
        verdict: 'DESCRIPTIVE',
        lo: null,
        hi: null,
      });
      expect(aaVerdict(input(diffs, { isFinalLook: true }))).toBe(
        'DESCRIPTIVE',
      );
    }
  });
  it('allows preregistered tiny sampling runs without manufacturing intervals', () => {
    expect(
      verdictFor({ ...input([1]), plan: { ...plan, looks: [1] } }),
    ).toMatchObject({ verdict: 'DESCRIPTIVE', lo: null, hi: null });
  });
  it('orients lower-is-better differences and resolves relative margin floors', () => {
    const lower: DecisionMetric = { ...metric, better: 'lower' };
    expect(
      verdictFor(input([-2, -2, -2, -2, -2], { metric: lower })),
    ).toMatchObject({ verdict: 'IMPROVEMENT', lo: 2, hi: 2 });
    expect(verdictFor(input([2, 2, 2, 2, 2], { metric: lower })).verdict).toBe(
      'REGRESSION',
    );
    const relative: DecisionMetric = {
      ...metric,
      margin: 0.05,
      relative: true,
      minMargin: 0.2,
    };
    expect(
      verdictFor(input([0, 0, 0, 0, 0], { metric: relative, baseMean: -100 }))
        .margin,
    ).toBe(5);
    expect(
      verdictFor(input([0, 0, 0, 0, 0], { metric: relative, baseMean: 0 }))
        .margin,
    ).toBe(0.2);
    expect(
      verdictFor(
        input([0, 0, 0, 0, 0], {
          metric: { ...relative, minMargin: 0 },
          baseMean: 0,
        }),
      ).margin,
    ).toBe(0);
  });
  it('detects A/A shift or excessive uncertainty at the final look', () => {
    expect(aaVerdict(input([-0.1, 0, 0.1, 0, 0]))).toBe('EQUIVALENT');
    expect(aaVerdict(input([0.2, 0.2, 0.2, 0.2, 0.2]))).toBe('INCONCLUSIVE');
    expect(
      aaVerdict(input([0.2, 0.2, 0.2, 0.2, 0.2], { isFinalLook: true })),
    ).toBe('UNSTABLE');
    expect(aaVerdict(input([-3, -1, 0, 1, 3]))).toBe('INCONCLUSIVE');
    expect(aaVerdict(input([-3, -1, 0, 1, 3], { isFinalLook: true }))).toBe(
      'UNSTABLE',
    );
    expect(aaVerdict(input([-0.1, 0, 0.1, 0, 0], { isFinalLook: true }))).toBe(
      'EQUIVALENT',
    );
  });
  it('stops only when every metric is resolved', () => {
    expect(shouldStop(['EQUIVALENT', 'NONINFERIOR', 'IMPROVEMENT'])).toBe(true);
    expect(shouldStop(['REGRESSION', 'UNSTABLE'])).toBe(true);
    expect(shouldStop(['EQUIVALENT', 'INCONCLUSIVE'])).toBe(false);
    expect(shouldStop(['EQUIVALENT', 'DESCRIPTIVE'])).toBe(false);
  });
});
