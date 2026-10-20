import { expect, it } from 'vitest';
import { memoryStore, type AcquireRequest } from 'valvejs';
import { countingStore } from '../src/adapters/valve.ts';
import type { AdapterContext } from '../src/adapters/types.ts';
import type { CallRecord } from '../src/core/types.ts';
import { libsCells } from '../src/plan/libs.ts';
import { memoryGrantEvents } from '../src/analyze/trial.ts';
import { checkRates } from '../src/oracle/server.ts';

it('records the admission clock rather than the earlier wrapper clock across a millisecond edge', () => {
  const calls: CallRecord[] = [];
  let clock = 1000;
  let sampled: number | undefined;
  const base = memoryStore({ clock: () => (sampled = clock) });
  const cell = libsCells('matrix', ['L2']).cells.find(
    (c) => c.library === 'valve',
  )!;
  const ctx: AdapterContext = {
    cell,
    worker: 0,
    instance: 0,
    quotaId: 'clock',
    keyPrefix: 'clock',
    valvePackageDir: '',
    now: () => clock - 1,
    onCall: (call) => calls.push(call),
  };
  const store = countingStore(base, ctx, () => sampled);
  const request: AcquireRequest = {
    id: 'clock',
    costs: [1],
    rules: [
      {
        key: 'gcra:1000',
        algorithm: 'gcra',
        intervalMs: 1000,
        limit: 200,
        burst: 1,
      },
    ],
  };
  expect(store.acquireSync!(request).granted).toBe(1);
  clock = 1005;
  expect(store.acquireSync!(request).granted).toBe(1);
  expect(calls.map((call) => call.dn)).toEqual([1000, 1005]);
  expect(checkRates(memoryGrantEvents(cell, calls)).violations).toEqual([]);
});
