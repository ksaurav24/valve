import { expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { valveAdapter } from '../src/adapters/valve.ts';
import { CATEGORIES } from '../src/adapters/registry.ts';

it.each([true, false])(
  'closes the memory store after Valve close fails (sync=%s)',
  async (sync) => {
    const dir = mkdtempSync(join(tmpdir(), 'valve-close-'));
    try {
      mkdirSync(join(dir, 'dist/redis'), { recursive: true });
      writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
      writeFileSync(
        join(dir, 'dist/redis/index.js'),
        'export const redisStore = () => {};',
      );
      writeFileSync(
        join(dir, 'dist/index.js'),
        `
      export const closed = [];
      export const memoryStore = () => ({kind:'memory',close(){closed.push('store');throw new Error('store close');}});
      export const createValve = () => ({wrap:fn=>fn,wrapFetch:fn=>fn,close(){closed.push('valve');${sync ? "throw new Error('valve close');" : "return Promise.reject(new Error('valve close'));"}}});
    `,
      );
      const limiter = await valveAdapter.create({
        cell: CATEGORIES.find((c) => c.id === 'L1')!.buildCell(),
        worker: 0,
        instance: 0,
        quotaId: 'cleanup',
        keyPrefix: 'cleanup',
        valvePackageDir: dir,
        onCall() {},
        now: Date.now,
      });
      await expect(limiter.close()).resolves.toBeUndefined();
      const module = await import(
        pathToFileURL(join(dir, 'dist/index.js')).href
      );
      expect(module.closed).toEqual(['valve', 'store']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
