/** Focused smoke tests for the T0 tinybench runner. */

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runMicro } from '../src/micro/run.ts';

describe('runMicro', () => {
  it('returns finite raw tinybench statistics for a filtered task', async () => {
    const valveModuleUrl = pathToFileURL(
      resolve('../valve/dist/index.js'),
    ).href;
    const results = await runMicro({
      filter: 'memoryStore.acquireSync',
      quick: true,
      valveModuleUrl,
    });

    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.suite).toBe('memoryStore.acquireSync');
      expect(result.task).toMatch(/rule/);
      for (const value of [
        result.opsPerSec,
        result.nsPerOp,
        result.p50,
        result.p99,
        result.samples,
      ]) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThan(0);
      }
      expect(Number.isFinite(result.rme)).toBe(true);
      expect(result.rme).toBeGreaterThanOrEqual(0);
    }
  });
});
