// Case-insensitive headers and conservative numeric and duration parsing.
import type { HeadersLike } from './types.js';
export function header(headers: HeadersLike, name: string): string | undefined {
  if ('get' in headers && typeof headers.get === 'function')
    return headers.get(name) ?? undefined;
  const record = headers as Readonly<
    Record<string, string | readonly string[] | number | undefined>
  >;
  const value =
    record[name] ??
    record[name.toLowerCase()] ??
    record[
      Object.keys(record).find(
        (key) => key.toLowerCase() === name.toLowerCase(),
      ) ?? ''
    ];
  return Array.isArray(value)
    ? value[0]
    : value === undefined
      ? undefined
      : String(value);
}
export function number(value: string | undefined): number | undefined {
  if (value === undefined || !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim()))
    return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}
export function reference(headers: HeadersLike) {
  const date = Date.parse(header(headers, 'date') ?? '');
  return Number.isFinite(date) ? date : Date.now();
}
// Keep retry eligibility and provider feedback on the same validation rules.
export function retryAfterMs(headers: HeadersLike): number | undefined {
  const value = header(headers, 'retry-after');
  if (value === undefined) return undefined;
  const seconds = number(value);
  const date = /[a-z]/i.test(value) ? Date.parse(value) : NaN;
  const pauseMs =
    seconds !== undefined
      ? seconds * 1000
      : Number.isFinite(date)
        ? Math.max(0, date - reference(headers))
        : undefined;
  return pauseMs !== undefined && Number.isFinite(pauseMs)
    ? pauseMs
    : undefined;
}
/** Split a structured-field list on commas outside quoted strings in one pass. */
export function items(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (quoted && char === '\\') i++;
    else if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) {
      parts.push(value.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}
export function compound(value: string | undefined): number | undefined {
  if (!value || !/^(?:\d+(?:\.\d+)?(?:ms|s|m|h))+$/.test(value))
    return undefined;
  let total = 0;
  for (const part of value.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g))
    total +=
      Number(part[1]) *
      ({ ms: 1, s: 1000, m: 60000, h: 3600000 }[part[2]!] ?? 0);
  return Number.isFinite(total) ? total : undefined;
}
