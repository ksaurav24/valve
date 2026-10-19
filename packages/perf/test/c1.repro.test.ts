import { expect, it } from 'vitest';
import { currentBuild } from '../src/identity/build.ts';
import { reproduceC1 } from '../src/tiers/c1.ts';

it('reports the inherited callback deadline defect as reproduced, not safe', async () => {
  const result = await reproduceC1(currentBuild({ rebuild: false }));
  expect(result.outcome).toBe('started');
  expect(result.reproduced).toBe(true);
  expect(result.lateMs).toBeGreaterThan(0);
});
