import { describe, expect, it } from 'vitest';
import { decode, encode, stable } from '../src/core/codec.ts';
import { planHash, type RunManifest } from '../src/core/manifest.ts';

describe('reproducibility contracts', () => {
  it('round trips non-finite numbers without changing strings, null or prototype names', () => {
    const value = {
      positive: Infinity,
      negative: -Infinity,
      nan: NaN,
      missing: null,
      literal: 'Infinity',
      constructor: 'constructor',
      toString: 'toString',
    };
    expect(decode(encode(value))).toEqual(value);
  });
  it('hashes shared references as values while rejecting actual cycles', () => {
    const x = { value: 1 };
    expect(stable({ a: x, b: x })).toBe(
      stable({ b: { value: 1 }, a: { value: 1 } }),
    );
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    expect(() => stable(cyclic)).toThrow('cyclic');
    expect(stable(Infinity)).not.toBe(stable('Infinity'));
  });
  it('includes lockfiles, authority and endpoints in the resume identity', () => {
    const base = {
      harnessSha256: 'h',
      fingerprintId: 'f',
      builds: {
        base: {
          distSha256: 'd',
          lockSha256: 'l',
          luaSha1: { ACQUIRE: 'a' },
          node: 'v24',
        },
      },
      arms: [],
      cells: [],
      reps: 5,
      baseSeed: 42,
      authoritative: false,
      servers: {},
    } as unknown as RunManifest;
    const hash = planHash(base);
    expect(planHash({ ...base, authoritative: true })).not.toBe(hash);
    expect(
      planHash({
        ...base,
        servers: {
          r: {
            image: 'redis:7.4',
            url: 'redis://127.0.0.1:16479',
            disposable: true,
          },
        },
      }),
    ).not.toBe(hash);
    expect(
      planHash({
        ...base,
        builds: { base: { ...base.builds.base!, lockSha256: 'different' } },
      }),
    ).not.toBe(hash);
  });
});
