// Seeded randomness. Every workload draw comes from here so arms replay identically.
import type { DistSpec } from './types.ts';

export type Random = () => number;

/** mulberry32: small, fast, deterministic 32-bit generator in [0, 1). */
export function mulberry32(seed: number): Random {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Derive an independent 32-bit seed from a base seed and labels (splitmix-style mixing). */
export function deriveSeed(
  base: number,
  ...labels: (string | number)[]
): number {
  let h = (base ^ 0x9e3779b9) >>> 0;
  for (const label of labels) {
    const s = String(label);
    for (let i = 0; i < s.length; i++) {
      h = Math.imul(h ^ s.charCodeAt(i), 0x85ebca6b) >>> 0;
      h ^= h >>> 13;
    }
    h = Math.imul(h ^ (h >>> 16), 0xc2b2ae35) >>> 0;
  }
  return h >>> 0;
}

/** Standard normal via Box-Muller. */
export function normal(rnd: Random): number {
  let u = 0;
  while (u === 0) u = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
}

/** Exponential with the given mean. */
export function exponential(rnd: Random, mean: number): number {
  return -Math.log(1 - rnd()) * mean;
}

/** Draw milliseconds from a distribution spec. Negative draws clamp to 0. */
export function sample(rnd: Random, d: DistSpec): number {
  switch (d.kind) {
    case 'fixed':
      return d.ms;
    case 'exp':
      return exponential(rnd, d.meanMs);
    case 'uniform':
      return d.minMs + rnd() * (d.maxMs - d.minMs);
    case 'lognormal':
      return d.medianMs * Math.exp(d.sigma * normal(rnd));
    case 'normal':
      return Math.max(0, d.meanMs + d.sdMs * normal(rnd));
    case 'mixed': {
      const total = d.parts.reduce((s, p) => s + p.weight, 0);
      let x = rnd() * total;
      for (const p of d.parts)
        if ((x -= p.weight) < 0) return sample(rnd, p.dist);
      return sample(rnd, d.parts.at(-1)!.dist);
    }
  }
}

/** Mean of a distribution spec (used by capacity models). */
export function mean(d: DistSpec): number {
  switch (d.kind) {
    case 'fixed':
      return d.ms;
    case 'exp':
      return d.meanMs;
    case 'uniform':
      return (d.minMs + d.maxMs) / 2;
    case 'lognormal':
      return d.medianMs * Math.exp((d.sigma * d.sigma) / 2);
    case 'normal':
      return d.meanMs;
    case 'mixed': {
      const total = d.parts.reduce((s, p) => s + p.weight, 0);
      return d.parts.reduce((s, p) => s + (p.weight / total) * mean(p.dist), 0);
    }
  }
}

/** Weighted choice by index. */
export function choose(rnd: Random, weights: readonly number[]): number {
  const total = weights.reduce((s, w) => s + w, 0);
  let x = rnd() * total;
  for (let i = 0; i < weights.length; i++) if ((x -= weights[i]!) < 0) return i;
  return weights.length - 1;
}

/** Zipf-distributed index in [0, n) with exponent s (s = 0 is uniform). */
export function zipf(rnd: Random, n: number, s: number): number {
  if (s === 0) return Math.floor(rnd() * n);
  const weights = Array.from({ length: n }, (_, i) => 1 / (i + 1) ** s);
  return choose(rnd, weights);
}

/** Seeded Fisher-Yates shuffle (returns a new array). */
export function shuffle<T>(rnd: Random, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
