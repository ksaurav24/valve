// Seeded greedy pairwise (2-way) covering array: every pair of factor levels appears in at
// least one row. Deterministic for a seed; far smaller than the full Cartesian product.
import { mulberry32, shuffle } from '../core/rng.ts';

export type Factors = Record<string, readonly (string | number)[]>;
export type Row = Record<string, string | number>;

export function pairwise(factors: Factors, seed = 1, candidates = 30): Row[] {
  const names = Object.keys(factors);
  const rnd = mulberry32(seed);
  const key = (
    a: string,
    va: string | number,
    b: string,
    vb: string | number,
  ) => `${a}=${va}|${b}=${vb}`;
  const uncovered = new Set<string>();
  for (let i = 0; i < names.length; i++)
    for (let j = i + 1; j < names.length; j++)
      for (const va of factors[names[i]!]!)
        for (const vb of factors[names[j]!]!)
          uncovered.add(key(names[i]!, va, names[j]!, vb));
  const rows: Row[] = [];
  const gain = (row: Row) => {
    let g = 0;
    for (let i = 0; i < names.length; i++)
      for (let j = i + 1; j < names.length; j++)
        if (
          uncovered.has(
            key(names[i]!, row[names[i]!]!, names[j]!, row[names[j]!]!),
          )
        )
          g++;
    return g;
  };
  while (uncovered.size) {
    let best: Row | undefined;
    let bestGain = -1;
    for (let c = 0; c < candidates; c++) {
      // Seed each candidate from one uncovered pair, then fill remaining factors greedily.
      const pick = [...uncovered][Math.floor(rnd() * uncovered.size)]!;
      const row: Row = {};
      for (const part of pick.split('|')) {
        const [n, v] = part.split('=') as [string, string];
        const level = factors[n]!.find((x) => String(x) === v)!;
        row[n] = level;
      }
      for (const n of shuffle(rnd, names)) {
        if (n in row) continue;
        let bestLevel = factors[n]![0]!;
        let bestLevelGain = -1;
        for (const level of shuffle(rnd, factors[n]!)) {
          row[n] = level;
          const g = gain(row);
          if (g > bestLevelGain) {
            bestLevelGain = g;
            bestLevel = level;
          }
        }
        row[n] = bestLevel;
      }
      const g = gain(row);
      if (g > bestGain) {
        bestGain = g;
        best = { ...row };
      }
    }
    if (!best || bestGain <= 0) break;
    for (let i = 0; i < names.length; i++)
      for (let j = i + 1; j < names.length; j++)
        uncovered.delete(
          key(names[i]!, best[names[i]!]!, names[j]!, best[names[j]!]!),
        );
    rows.push(best);
  }
  return rows;
}

/** Verify that `rows` cover every level pair of `factors`. */
export function coversAllPairs(
  factors: Factors,
  rows: readonly Row[],
): boolean {
  const names = Object.keys(factors);
  for (let i = 0; i < names.length; i++)
    for (let j = i + 1; j < names.length; j++)
      for (const va of factors[names[i]!]!)
        for (const vb of factors[names[j]!]!)
          if (!rows.some((r) => r[names[i]!] === va && r[names[j]!] === vb))
            return false;
  return true;
}
