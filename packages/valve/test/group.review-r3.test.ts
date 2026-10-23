// Regression cases from the third independent lifecycle review.
import { describe, expect, it, vi } from 'vitest';
import { memoryStore } from '../src/index.js';
import { createValveGroup } from '../src/group/index.js';
import type { ValveGroupOptions } from '../src/group/index.js';

const outcome = (job: Promise<unknown>) =>
  job.catch((error: { code: string }) => error.code);

async function blockedRoom(options: Partial<ValveGroupOptions> = {}) {
  const store = memoryStore();
  const release = store.release!.bind(store);
  const subscribe = vi.spyOn(store, 'subscribe');
  let open!: () => void;
  const gate = new Promise<void>((done) => (open = done));
  store.release = async (...args) => {
    await gate;
    return release(...args);
  };
  const group = createValveGroup({
    id: 'review-r3',
    store,
    maxSize: 1,
    resolve: () => ({ concurrency: { limit: 1, scope: 'global' } }),
    ...options,
  });
  // Also works with a scoped resolver in the identity tests below.
  await group.run(
    'a',
    () => 1,
    options.resolve ? { scopes: { user: 'seed' } } : {},
  );
  return {
    group,
    open,
    subscribe,
    close: async () => {
      open();
      await group.close();
      await store.close();
    },
  };
}

describe('group acquisition snapshots', () => {
  for (const method of [
    'run',
    'wrap',
    'wrapFetch',
    'wrapFetch resolver',
  ] as const) {
    it(`snapshots ${method} identities before waiting for room`, async () => {
      const test = await blockedRoom({
        resolve: () => ({
          concurrency: { limit: 1, scope: 'global' },
          rate: {
            name: 'user',
            scope: 'user',
            limit: 1,
            interval: '1h',
            algorithm: 'fixed-window',
          },
        }),
      });
      try {
        const scopes = { user: 'alice' };
        const options = { scopes, priority: 1 };
        const member = test.group.get('b');
        const fetchImpl = vi.fn(async () => ({ status: 200, headers: {} }));
        const waiting =
          method === 'run'
            ? member.run(() => 1, options)
            : method === 'wrap'
              ? member.wrap(() => 1, options)()
              : member.wrapFetch(
                  fetchImpl,
                  method === 'wrapFetch resolver'
                    ? { ...options, scopes: () => scopes }
                    : options,
                )();
        scopes.user = 'bob';
        options.scopes = { user: 'carol' };
        test.open();
        await waiting;
        for (const user of ['alice', 'bob', 'carol']) {
          const result = await outcome(
            member.run(() => 'granted', { scopes: { user }, maxWait: 0 }),
          );
          expect(result).toBe(
            user === 'alice' ? 'MAX_WAIT_EXCEEDED' : 'granted',
          );
        }
      } finally {
        await test.close();
      }
    });
  }

  it('guards reentrant option getters without exceeding maxPending', async () => {
    const test = await blockedRoom({ maxPending: 1 });
    try {
      const pending: Promise<unknown>[] = [];
      let reads = 0;
      const signal = new AbortController().signal;
      const options = {
        get signal(): AbortSignal {
          if (++reads < 32)
            pending.push(outcome(test.group.run('b', () => 1, options)));
          return signal;
        },
      };
      pending.push(outcome(test.group.run('b', () => 1, options)));
      test.open();
      const results = await Promise.all(pending);
      expect(results.filter((value) => value === 1)).toHaveLength(1);
      expect(
        results.filter((value) => value === 'INVALID_OPTIONS'),
      ).toHaveLength(1);
      expect(reads).toBe(1);
    } finally {
      await test.close();
    }
  });

  it('rejects expired waiters before constructing or subscribing a child', async () => {
    const test = await blockedRoom();
    try {
      const waiting = outcome(test.group.run('b', () => 'ran', { maxWait: 5 }));
      // Timers cannot preempt JS; eviction completion runs before the timer.
      const until = Date.now() + 20;
      while (Date.now() < until) {
        /* hold the timer turn */
      }
      test.open();
      expect(await waiting).toBe('MAX_WAIT_EXCEEDED');
      expect(test.subscribe.mock.calls.map(([id]) => id)).toEqual([
        'review-r3:a',
      ]);
      expect(test.group.stats()).toEqual({ size: 0, active: 0 });
    } finally {
      await test.close();
    }
  });
});
