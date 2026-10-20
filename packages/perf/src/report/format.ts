// Shared presentation conventions for benchmark reports; values remain raw absolutes.
import type { PerfVerdict, SafetyStatus } from '../core/types.ts';

/** Presentation metadata for a metric, in its stored units. */
export interface MetricDisplay {
  label: string;
  unit: string;
  better?: 'higher' | 'lower';
  note?: string;
}
/** Known metric labels and units, including censoring and theoretical-bound labels. */
export const metricRegistry: Record<string, MetricDisplay> = {};
for (const key of [
  'offeredPerSec',
  'ruleCapacityPerSec',
  'idealBoundPerSec',
  'admittedPerSec',
  'usefulStartsPerSec',
  'completionsPerSec',
  'opsPerSec',
])
  metricRegistry[key] = {
    label: key,
    unit: '/s',
    ...(key === 'idealBoundPerSec' ? { note: 'not attainable' } : {}),
  };
for (const key of [
  'boundEfficiency',
  'capacityUtilization',
  'goodput',
  'deadlineSuccess',
  'minShare',
  'wastedGrantFraction',
])
  metricRegistry[key] = { label: key, unit: '%' };
for (const key of [
  'callsPerGrant',
  'zeroGrantPerGrant',
  'earlyZeroPerGrant',
  'lostRacePerGrant',
  'jain',
  'leaseMaxOccupancy',
])
  metricRegistry[key] = { label: key, unit: '' };
for (const key of [
  'redisCpuUsPerGrant',
  'evalshaUsPerCall',
  'appCpuUsPerGrant',
])
  metricRegistry[key] = { label: key, unit: 'µs', better: 'lower' };
for (const key of [
  'waitP50',
  'waitP95',
  'waitP99',
  'waitP999',
  'cifP50',
  'cifP95',
  'cifP99',
  'failureRankedP99',
  'eldP99Ms',
  'maxNoStartGapMs',
  'generatorLagP99Ms',
])
  metricRegistry[key] = {
    label: key,
    unit: 'ms',
    better: 'lower',
    ...(key.startsWith('wait')
      ? { note: 'conditional on starting' }
      : key.startsWith('cif')
        ? { note: 'CIF (Aalen-Johansen)' }
        : key.startsWith('failureRanked')
          ? { note: 'failure-ranked (conservative)' }
          : {}),
  };
metricRegistry.maxRssMB = { label: 'maxRssMB', unit: 'MB', better: 'lower' };
metricRegistry.nsPerOp = { label: 'nsPerOp', unit: 'ns', better: 'lower' };
/** Format a scalar with significant digits and explicit missing/non-finite labels. */
export function formatNumber(value: number | null, digits = 4): string {
  if (value === null) return '-';
  if (value === Infinity) return 'not reached (∞)';
  if (value === -Infinity) return '−∞ (unbounded)';
  if (Number.isNaN(value)) return 'not measurable (NaN)';
  return String(Number(value.toPrecision(digits)));
}
/** Format a stored metric value with its display unit. */
export function formatMetric(value: number | null, key: string): string {
  const unit =
    (metricRegistry[key] ?? metricRegistry[key.split('.').at(-1)!])?.unit ?? '';
  return `${formatNumber(value === null ? null : unit === '%' ? value * 100 : value)}${unit ? ` ${unit}` : ''}`;
}
/** Return a label that preserves censoring and bound qualifications. */
export function metricLabel(key: string): string {
  const item = metricRegistry[key] ?? metricRegistry[key.split('.').at(-1)!];
  return item
    ? `${key}${item.note ? ` (${item.note})` : ''}${item.unit ? ` [${item.unit}]` : ''}`
    : key;
}
/** Render a performance verdict without conflating it with safety. */
export function verdictBadge(verdict: PerfVerdict): string {
  return verdict;
}
/** Render the absolute safety status without downgrading failures. */
export function safetyBadge(status: SafetyStatus): string {
  return status;
}
