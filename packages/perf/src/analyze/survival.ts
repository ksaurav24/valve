// Product-limit survival and competing-risk time-to-start estimates.
import { conditionalPercentiles, failureRanked } from './quantile.ts';

function grouped(times: readonly number[], causes: readonly number[]) {
  if (times.length !== causes.length)
    throw new RangeError('times and causes must have equal length');
  const groups = new Map<
    number,
    { censored: number; events: Map<number, number> }
  >();
  times.forEach((t, i) => {
    const cause = causes[i]!;
    if (!Number.isFinite(t) || t < 0 || !Number.isInteger(cause) || cause < 0)
      throw new RangeError(
        'times must be finite nonnegative values and causes nonnegative integers',
      );
    let group = groups.get(t);
    if (!group) {
      group = { censored: 0, events: new Map() };
      groups.set(t, group);
    }
    if (cause === 0) group.censored++;
    else group.events.set(cause, (group.events.get(cause) ?? 0) + 1);
  });
  return [...groups].sort(([a], [b]) => a - b);
}

/** Kaplan-Meier steps at each observed time; same-time censoring remains in the risk set. */
export function kaplanMeier(
  times: readonly number[],
  events: readonly (0 | 1)[],
) {
  let atRisk = times.length;
  let survival = 1;
  return grouped(times, events).map(([t, group]) => {
    const count = group.events.get(1) ?? 0;
    survival *= 1 - count / atRisk;
    const step = {
      t,
      survival,
      atRisk,
      events: count,
      censored: group.censored,
    };
    atRisk -= count + group.censored;
    return step;
  });
}

/** Aalen-Johansen estimate on the observed timeline, with columns for observed nonzero causes. */
export interface AalenJohansenResult {
  times: number[];
  cif: Record<number, number[]>;
  survival: number[];
}

/** Joint competing-event updates use pre-event survival; censoring at t exits after events at t. */
export function aalenJohansen(
  times: readonly number[],
  causes: readonly number[],
): AalenJohansenResult {
  const groups = grouped(times, causes);
  const keys = [...new Set(causes.filter((cause) => cause > 0))].sort(
    (a, b) => a - b,
  );
  const cif: Record<number, number[]> = Object.fromEntries(
    keys.map((cause) => [cause, []]),
  );
  const cumulative: Record<number, number> = Object.fromEntries(
    keys.map((cause) => [cause, 0]),
  );
  const result: AalenJohansenResult = { times: [], cif, survival: [] };
  let atRisk = times.length;
  let survival = 1;
  for (const [t, group] of groups) {
    let events = 0;
    for (const cause of keys) {
      const count = group.events.get(cause) ?? 0;
      events += count;
      cumulative[cause] = cumulative[cause]! + (survival * count) / atRisk;
      cif[cause]!.push(cumulative[cause]!);
    }
    survival *= 1 - events / atRisk;
    result.times.push(t);
    result.survival.push(survival);
    atRisk -= events + group.censored;
  }
  return result;
}

/** First observed time whose cause-specific CIF reaches q; q=0 returns the time origin. */
export function cifQuantile(
  result: AalenJohansenResult,
  cause: number,
  q: number,
): number | 'not-reached' {
  if (!(q >= 0 && q <= 1)) throw new RangeError('q must be in [0, 1]');
  if (q === 0) return 0;
  const index = result.cif[cause]?.findIndex((value) => value >= q) ?? -1;
  return index === -1 ? 'not-reached' : result.times[index]!;
}

/** Recorded wait and terminal class; aborts and observation-end unserved jobs are censored. */
export interface StartTimeRecord {
  wait: number;
  outcome: 'started' | 'expired' | 'rejected' | 'aborted' | 'unserved';
}

/** Three labelled views; assumes non-informative censoring for aborts and unserved jobs. */
export function startTimeSummary(
  records: readonly StartTimeRecord[],
  qs: readonly number[] = [0.5, 0.9, 0.95, 0.99],
) {
  const counts = {
    started: 0,
    expired: 0,
    rejected: 0,
    aborted: 0,
    unserved: 0,
  };
  const waits: number[] = [];
  const causes = {
    started: 1,
    expired: 2,
    rejected: 3,
    aborted: 0,
    unserved: 0,
  } as const;
  for (const record of records) {
    counts[record.outcome]++;
    if (record.outcome === 'started') waits.push(record.wait);
  }
  const estimate = aalenJohansen(
    records.map((record) => record.wait),
    records.map((record) => causes[record.outcome]),
  );
  return {
    counts,
    conditional: conditionalPercentiles(waits, qs),
    cif: Object.fromEntries(
      qs.map((q) => [`p${q * 100}`, cifQuantile(estimate, 1, q)]),
    ),
    cifMaxStart: estimate.cif[1]?.at(-1) ?? 0,
    failureRanked: Object.fromEntries(
      qs.map((q) => [
        `p${q * 100}`,
        failureRanked(waits, records.length - waits.length, q),
      ]),
    ),
  };
}
