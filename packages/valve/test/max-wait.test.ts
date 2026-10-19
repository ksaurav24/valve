// Granted jobs must still be eligible when their callback microtask executes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createValve, memoryStore } from '../src/index.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => vi.useRealTimers());

describe.each(['sync', 'async'] as const)('%s admission', (kind) => {
  it.each([99, 100, 130])(
    'checks a positive deadline after an earlier callback advances time to %ims',
    async (elapsed) => {
      const store = memoryStore();
      if (kind === 'async') delete store.acquireSync;
      const acquire = vi.spyOn(
        store,
        kind === 'sync' ? 'acquireSync' : 'acquire',
      );
      const valve = createValve({ id: 'deadline', concurrency: 2, store });
      const rejected = vi.fn();
      valve.on('reject', rejected);
      const fn = vi.fn(() => 'second');
      try {
        const first = valve.run(() => vi.setSystemTime(elapsed));
        const second = valve.run(fn, { maxWait: 100 });
        const outcomes = await Promise.allSettled([first, second]);
        expect(acquire.mock.calls[0]![0].costs).toHaveLength(2);
        expect(outcomes[0]!.status).toBe('fulfilled');
        if (elapsed < 100) {
          expect(outcomes[1]).toEqual({ status: 'fulfilled', value: 'second' });
          expect(fn).toHaveBeenCalledOnce();
        } else {
          expect(outcomes[1]).toMatchObject({
            status: 'rejected',
            reason: { code: 'MAX_WAIT_EXCEEDED' },
          });
          expect(fn).not.toHaveBeenCalled();
          expect(rejected).toHaveBeenCalledExactlyOnceWith({
            code: 'MAX_WAIT_EXCEEDED',
          });
        }
        expect(valve.stats()).toMatchObject({
          queued: 0,
          running: 0,
          totals: {
            started: elapsed < 100 ? 2 : 1,
            succeeded: elapsed < 100 ? 2 : 1,
            failed: 0,
            rejected: elapsed < 100 ? 0 : 1,
          },
        });
        expect(await valve.run(() => 'replacement')).toBe('replacement');
        await valve.idle();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        await valve.close();
        await store.close();
      }
    },
  );

  it.each(['deadline', 'abort', 'abort-at-deadline', 'zero'] as const)(
    'releases reserved global slots before invocation for %s',
    async (scenario) => {
      const store = memoryStore();
      if (kind === 'async') delete store.acquireSync;
      const release = vi.spyOn(store, 'release');
      const valve = createValve({
        id: 'leased-deadline',
        concurrency: { limit: 2, scope: 'global', leaseTtl: 1000 },
        store,
      });
      const controller = new AbortController();
      const fn = vi.fn();
      try {
        const first = valve.run(() => {
          if (scenario !== 'abort') vi.setSystemTime(100);
          if (scenario === 'abort' || scenario === 'abort-at-deadline')
            controller.abort('cancelled');
        });
        const second = valve.run(fn, {
          maxWait: scenario === 'zero' ? 0 : 100,
          signal: controller.signal,
        });
        const third = valve.run(() => 'replacement');
        const outcomes = await Promise.allSettled([first, second, third]);
        expect(outcomes[1]).toMatchObject(
          scenario === 'zero'
            ? { status: 'fulfilled' }
            : {
                status: 'rejected',
                reason: {
                  code:
                    scenario === 'deadline' ? 'MAX_WAIT_EXCEEDED' : 'ABORTED',
                },
              },
        );
        expect(fn).toHaveBeenCalledTimes(scenario === 'zero' ? 1 : 0);
        expect(outcomes[2]).toEqual({
          status: 'fulfilled',
          value: 'replacement',
        });
        await valve.idle();
        await valve.close();
        const tokens = release.mock.calls.flatMap(([, leases]) => [...leases]);
        expect(tokens).toHaveLength(3);
        expect(new Set(tokens).size).toBe(3);
        expect(valve.stats()).toMatchObject({
          queued: 0,
          running: 0,
          totals: {
            started: scenario === 'zero' ? 3 : 2,
            succeeded: scenario === 'zero' ? 3 : 2,
            failed: 0,
            rejected: scenario === 'zero' ? 0 : 1,
          },
        });
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        await valve.close();
        await store.close();
      }
    },
  );
});
