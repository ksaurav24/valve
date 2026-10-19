// JSON that keeps non-finite numbers distinguishable from missing values.
// Non-finite numbers use tagged objects, preserving literal strings and null.
const TAGS: Record<string, number> = {
  Infinity: Infinity,
  '-Infinity': -Infinity,
  NaN: NaN,
};

/** Stringify with non-finite numbers tagged as strings. */
export function encode(value: unknown, space?: number): string {
  return JSON.stringify(
    value,
    (_key, v: unknown) =>
      typeof v === 'number' && !Number.isFinite(v)
        ? { $valveNumber: String(v) }
        : v,
    space,
  );
}

/** Parse JSON produced by `encode`, restoring tagged non-finite numbers. */
export function decode<T = unknown>(text: string): T {
  return JSON.parse(text, (_key, v: unknown) =>
    v !== null &&
    typeof v === 'object' &&
    Object.keys(v).length === 1 &&
    '$valveNumber' in v &&
    typeof v.$valveNumber === 'string' &&
    Object.hasOwn(TAGS, v.$valveNumber)
      ? TAGS[v.$valveNumber]
      : v,
  ) as T;
}

/** Parse newline-delimited JSON produced by `encode`. Blank lines are skipped. */
export function decodeLines<T = unknown>(text: string): T[] {
  const out: T[] = [];
  for (const line of text.split('\n'))
    if (line.trim()) out.push(decode<T>(line));
  return out;
}

/** Deterministic JSON with sorted object keys, for hashing configurations. */
export function stable(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (typeof v === 'number' && !Number.isFinite(v))
      return { $valveNumber: String(v) };
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v)) throw new Error('stable(): cyclic value');
    seen.add(v);
    if (Array.isArray(v)) {
      const out = v.map(walk);
      seen.delete(v);
      return out;
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v).sort()) {
      const item = (v as Record<string, unknown>)[key];
      if (item !== undefined) out[key] = walk(item);
    }
    seen.delete(v);
    return out;
  };
  return JSON.stringify(walk(value));
}
