import { expect, it } from 'vitest';
import { currentBuild } from '../src/identity/build.ts';
import { c1Safety, classifyC1, reproduceC1 } from '../src/tiers/c1.ts';

it('verifies an expired callback is skipped with MAX_WAIT_EXCEEDED', async () => {
  const result = await reproduceC1(currentBuild({ rebuild: false }));
  expect(result).toMatchObject({
    safety: 'PASS',
    outcome: 'rejected',
    rejectionCode: 'MAX_WAIT_EXCEEDED',
    firstOutcome: 'fulfilled',
    blockedThroughDeadline: true,
    reproduced: false,
    lateMs: 0,
  });
});

it('withholds a safety pass for unrelated rejection or an ineffective probe', () => {
  const rejected = {
    lateMs: 0,
    outcome: 'rejected' as const,
    firstOutcome: 'fulfilled' as const,
    blockedThroughDeadline: true,
    rejectionCode: 'MAX_WAIT_EXCEEDED',
  };
  expect(classifyC1({ ...rejected, rejectionCode: 'ABORTED' })).toBe(
    'UNVERIFIED',
  );
  expect(classifyC1({ ...rejected, firstOutcome: 'rejected' })).toBe(
    'UNVERIFIED',
  );
  expect(classifyC1({ ...rejected, blockedThroughDeadline: false })).toBe(
    'UNVERIFIED',
  );
  expect(classifyC1({ ...rejected, outcome: 'started' })).toBe('UNVERIFIED');
  expect(classifyC1({ ...rejected, lateMs: 30, outcome: 'started' })).toBe(
    'FAIL',
  );
});

it('preserves historical failure and missing coverage when re-rendering evidence', () => {
  expect(c1Safety([{ reproduced: true }])).toBe('FAIL');
  expect(c1Safety([{ reproduced: false }])).toBe('UNVERIFIED');
  expect(c1Safety([])).toBe('UNVERIFIED');
  expect(c1Safety([{ reproduced: false, safety: 'PASS' }])).toBe('PASS');
  expect(
    c1Safety([{ reproduced: false, safety: 'PASS' }, { reproduced: true }]),
  ).toBe('FAIL');
});
