// Lifelines golden survival curves, simultaneous ties, and start-outcome views.
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import golden from './fixtures/golden-stats.json' with { type: 'json' };
import {
  aalenJohansen,
  cifQuantile,
  kaplanMeier,
  startTimeSummary,
} from '../src/analyze/survival.ts';

describe('survival reference fixtures', () => {
  it('matches lifelines Kaplan-Meier at every observed time to 1e-9', () => {
    for (const row of golden.survival) {
      const actual = kaplanMeier(
        row.times,
        row.causes.map((cause) => (cause === 0 ? 0 : 1)),
      );
      expect(actual).toHaveLength(row.km.length);
      actual.forEach((step, i) => {
        const expected = row.km[i]!;
        expect(step).toMatchObject({
          t: expected.t,
          atRisk: expected.atRisk,
          events: expected.events,
          censored: expected.censored,
        });
        expect(Math.abs(step.survival - expected.survival)).toBeLessThanOrEqual(
          1e-9,
        );
      });
    }
  });
  it('matches lifelines AJ after deterministic tie collapse to 1e-9', () => {
    for (const row of golden.survival) {
      const actual = aalenJohansen(row.times, row.causes);
      expect(actual.times).toEqual(row.aj.times);
      actual.survival.forEach((s, i) =>
        expect(Math.abs(s - row.aj.survival[i]!)).toBeLessThanOrEqual(1e-9),
      );
      for (const [cause, values] of Object.entries(row.aj.cif)) {
        actual.cif[Number(cause)]!.forEach((value, i) =>
          expect(Math.abs(value - values[i]!)).toBeLessThanOrEqual(1e-9),
        );
      }
    }
  });
  it('counts same-time censoring at risk and updates all causes from pre-event survival', () => {
    const result = aalenJohansen([1, 1, 1, 2], [1, 2, 0, 1]);
    expect(result).toEqual({
      times: [1, 2],
      cif: { 1: [0.25, 0.75], 2: [0.25, 0.25] },
      survival: [0.5, 0],
    });
    expect(cifQuantile(result, 1, 0.5)).toBe(2);
    expect(cifQuantile(result, 2, 0.25)).toBe(1);
    expect(cifQuantile(result, 2, 0.5)).toBe('not-reached');
    expect(cifQuantile(result, 9, 0.5)).toBe('not-reached');
    expect(cifQuantile(result, 1, 0)).toBe(0);
  });
  it('handles empty, all-censored, and invalid samples', () => {
    expect(kaplanMeier([], [])).toEqual([]);
    expect(aalenJohansen([], [])).toEqual({ times: [], cif: {}, survival: [] });
    expect(aalenJohansen([1, 2], [0, 0])).toEqual({
      times: [1, 2],
      cif: {},
      survival: [1, 1],
    });
    expect(() => aalenJohansen([1], [])).toThrow(RangeError);
    expect(() => aalenJohansen([-1], [1])).toThrow(RangeError);
    expect(() => cifQuantile(aalenJohansen([], []), 1, 2)).toThrow(RangeError);
  });
});

describe('survival properties and outcome summaries', () => {
  it('conserves probability, monotonicity, and invariance to input order with ties', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            t: fc.integer({ min: 0, max: 10 }),
            cause: fc.integer({ min: 0, max: 3 }),
          }),
          { maxLength: 100 },
        ),
        (records) => {
          const result = aalenJohansen(
            records.map((row) => row.t),
            records.map((row) => row.cause),
          );
          const reversed = [...records].reverse();
          expect(
            aalenJohansen(
              reversed.map((row) => row.t),
              reversed.map((row) => row.cause),
            ),
          ).toEqual(result);
          result.survival.forEach((s, i) => {
            const total = Object.values(result.cif).reduce(
              (sum, values) => sum + values[i]!,
              s,
            );
            expect(total).toBeLessThanOrEqual(1 + 1e-12);
            expect(total).toBeCloseTo(1, 12);
            expect(s).toBeGreaterThanOrEqual(0);
            if (i > 0) expect(s).toBeLessThanOrEqual(result.survival[i - 1]!);
            for (const values of Object.values(result.cif)) {
              expect(values[i]!).toBeGreaterThanOrEqual(
                i === 0 ? 0 : values[i - 1]!,
              );
            }
          });
        },
      ),
    );
  });
  it('separates conditional, incidence, and failure-ranked views with counts', () => {
    const summary = startTimeSummary(
      [
        { wait: 1, outcome: 'started' },
        { wait: 1, outcome: 'expired' },
        { wait: 2, outcome: 'rejected' },
        { wait: 3, outcome: 'aborted' },
        { wait: 4, outcome: 'unserved' },
      ],
      [0.5, 0.9],
    );
    expect(summary).toEqual({
      counts: { started: 1, expired: 1, rejected: 1, aborted: 1, unserved: 1 },
      conditional: { p50: 1, p90: 1 },
      cif: { p50: 'not-reached', p90: 'not-reached' },
      cifMaxStart: 0.2,
      failureRanked: { p50: 'failure', p90: 'failure' },
    });
    const censored = startTimeSummary(
      [
        { wait: 1, outcome: 'aborted' },
        { wait: 2, outcome: 'started' },
      ],
      [0.5],
    );
    expect(censored.cifMaxStart).toBe(1);
    expect(censored.cif.p50).toBe(2);
    expect(startTimeSummary([]).conditional.p50).toBeNull();
    expect(startTimeSummary([]).cif.p50).toBe('not-reached');
    expect(startTimeSummary([]).cifMaxStart).toBe(0);
  });
});
