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
  it('preserves an observer method receiver and its feedback', async () => {
    class Options {
      #status = 429;
      observe() {
        return { status: this.#status, headers: { 'retry-after': '1' } };
      }
    }
    const group = createValveGroup({
      id: 'observer-receiver',
      resolve: () => ({ concurrency: 1 }),
    });
    const warnings = vi.fn();
    group.on('warning', warnings);
    try {
      await group.run('a', () => 1, new Options());
      expect(group.get('a').stats()?.pausedUntil).not.toBeNull();
      expect(warnings).not.toHaveBeenCalled();
    } finally {
      await group.close();
    }
  });

  it('preserves inherited run options and resolver configuration', async () => {
    const controller = new AbortController();
    controller.abort();
    class Rule {
      get limit() {
        return 1;
      }
      get interval() {
        return '1h' as const;
      }
    }
    class Policy {
      get concurrency() {
        return 1;
      }
      get rate() {
        return new Rule();
      }
    }
    class Canceled {
      get signal() {
        return controller.signal;
      }
    }
    class Expensive {
      get cost() {
        return 2;
      }
    }
    const group = createValveGroup({
      id: 'prototype-options',
      resolve: () => new Policy(),
    });
    const work = vi.fn(() => 1);
    try {
      await expect(group.run('a', work, new Canceled())).rejects.toMatchObject({
        code: 'ABORTED',
      });
      await expect(group.run('b', work, new Expensive())).rejects.toMatchObject(
        { code: 'COST_EXCEEDS_LIMIT' },
      );
      expect(work).not.toHaveBeenCalled();
      await expect(group.run('c', work)).resolves.toBe(1);
    } finally {
      await group.close();
    }
  });

  it('preserves prototype fetch options and RequestInit fields', async () => {
    class Init {
      get method() {
        return 'POST';
      }
      get body() {
        return 'payload';
      }
    }
    class Options {
      get cost() {
        return 2;
      }
      get retries() {
        return 0;
      }
    }
    const group = createValveGroup({
      id: 'prototype-fetch',
      resolve: () => ({ rate: { limit: 1, interval: '1h' } }),
    });
    const echo = vi.fn(async (url: string, init?: RequestInit) => {
      const request = new Request(url, init);
      return {
        status: 200,
        headers: {},
        method: request.method,
        body: await request.text(),
      };
    });
    try {
      const member = group.get('a');
      await expect(
        member.wrapFetch(echo, new Options())(
          'https://example.test/',
          new Init(),
        ),
      ).rejects.toMatchObject({ code: 'COST_EXCEEDS_LIMIT' });
      expect(echo).not.toHaveBeenCalled();
      await expect(
        member.wrapFetch(echo)('https://example.test/', new Init()),
      ).resolves.toMatchObject({ method: 'POST', body: 'payload' });
    } finally {
      await group.close();
    }
  });

  for (const method of [
    'run',
    'run function',
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
        const options = Object.assign(
          method === 'run function' ? () => undefined : {},
          { scopes, priority: 1 },
        );
        const member = test.group.get('b');
        const fetchImpl = vi.fn(async () => ({ status: 200, headers: {} }));
        const waiting =
          method === 'run' || method === 'run function'
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
