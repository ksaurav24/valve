// Millisecond duration parsing and finite-number validation.
import { invalid } from './errors.js';
import type { Duration } from './types.js';
export function duration(
  value: Duration,
  id?: string,
  option = 'duration',
): number {
  let ms: number;
  if (typeof value === 'number') ms = value;
  else {
    const match = /^(\d+(?:\.\d+)?|\.\d+)(ms|s|m|h)$/.exec(value);
    const units: Record<string, number> = {
      ms: 1,
      s: 1000,
      m: 60000,
      h: 3600000,
    };
    ms = match ? Number(match[1]) * units[match[2]!]! : NaN;
  }
  if (!Number.isFinite(ms) || ms < 0 || ms > Number.MAX_SAFE_INTEGER)
    invalid(
      id,
      `${option} must be a finite nonnegative duration`,
      value,
      'Use milliseconds or a string ending in ms, s, m, or h',
    );
  return ms;
}
export function integer(
  value: number,
  id: string | undefined,
  option: string,
  infinity = false,
): number {
  if (
    (!Number.isSafeInteger(value) || value < 1) &&
    !(infinity && value === Infinity)
  )
    invalid(
      id,
      `${option} must be a positive integer`,
      value,
      'Use a positive whole number',
    );
  return value;
}
