// Registration must remain untouched when a first admin patch cannot commit.
import { expect, it, vi } from 'vitest';
import { createValve, memoryStore } from '../src/index.js';
import { normalize } from '../src/rules.js';

it('does not pin a new memory id on an unsafe or conflicting initial update', async () => {
  for (const conflict of [false, true]) {
    const store = memoryStore({ clock: () => 1000 });
    const id = `uncommitted-${conflict}`;
    const rules = normalize({
      id,
      limits: 'managed',
      rate: { name: 'r', limit: 1, interval: 1000 },
    }).rules;
    await expect(
      store.managed!.updateLimits({
        id,
        rules,
        patch: { r: { burst: conflict ? 2 : Number.MAX_SAFE_INTEGER } },
        ...(conflict ? { expect: { r: { limit: 2 } } } : {}),
      }),
    ).rejects.toMatchObject({
      code: conflict ? 'LIMITS_CONFLICT' : 'INVALID_OPTIONS',
    });
    const otherRules = normalize({
      id,
      limits: 'managed',
      rate: { name: 'r', limit: 1, interval: 2000 },
    }).rules;
    expect(
      (await store.managed!.getLimits({ id, rules: otherRules })).rules.r!
        .intervalMs,
    ).toBe(2000);
    await store.close();
  }
});

it('preserves fractional debt through thousands of small rate rebases at an epoch-sized coordinate', async () => {
  let now = 1792660000000;
  const store = memoryStore({ clock: () => now });
  const id = 'rebase-rounding';
  const rules = normalize({
    id,
    limits: 'managed',
    rate: { name: 'r', interval: 18, limit: 43, burst: 1000 },
  }).rules;
  expect(
    store.managed!.acquireSync!({ id, rules, costs: [1000] }).granted,
  ).toBe(1);
  for (let i = 0; i < 3598; i++) {
    now++;
    await store.managed!.updateLimits({
      id,
      rules,
      patch: { r: { limit: i % 2 ? 6 : 2 } },
    });
  }
  // Exact integrated drain is 14429/18 = 801.611..., which cannot pay for 802.
  expect(store.managed!.acquireSync!({ id, rules, costs: [802] }).granted).toBe(
    0,
  );
  expect(store.managed!.acquireSync!({ id, rules, costs: [801] }).granted).toBe(
    1,
  );
  await store.close();
});

it.each([
  { leases: [{}] },
  { leases: [''] },
  { leases: 'x' },
  { leases: 42 },
  { leases: null },
])(
  'rejects malformed static global managed tokens $leases before invoking work',
  async ({ leases }) => {
    const backing = memoryStore();
    const managed = {
      ...backing.managed!,
      acquireSync: () =>
        ({ granted: 1, retryAfterMs: 0, pausedMs: 0, leases }) as never,
    };
    const api = createValve({
      id: 'bad-token',
      limits: 'managed',
      store: { ...backing, managed },
      concurrency: { scope: 'global', limit: 1, leaseTtl: 1000 },
      rate: { name: 'r', limit: 1, interval: 1000 },
    });
    const fn = vi.fn();
    try {
      await expect(api.run(fn)).rejects.toMatchObject({
        code: 'INVALID_OPTIONS',
      });
      expect(fn).not.toHaveBeenCalled();
    } finally {
      await api.close();
      await backing.close();
    }
  },
);

it.each([false, true])(
  'settles jobs when an async managed snapshot is malformed (scoped=%s)',
  async (scoped) => {
    const backing = memoryStore();
    const managed = { ...backing.managed! };
    delete managed.acquireSync;
    delete managed.acquireScopedSync;
    const limits = { version: '1.1', revision: 1, rules: {} };
    managed.acquire = async () => ({
      granted: 0,
      retryAfterMs: 1,
      pausedMs: 0,
      limits,
    });
    managed.acquireScoped = async () => ({
      grantedIndexes: [],
      blocked: [{ index: 0, retryAfterMs: 1 }],
      limits,
    });
    const api = createValve({
      id: `invalid-snapshot-${scoped}`,
      limits: 'managed',
      onStoreError: 'open',
      maxWait: 500,
      store: { ...backing, managed },
      rate: {
        name: 'r',
        limit: 1,
        interval: 1000,
        ...(scoped ? { scope: 'recipient' } : {}),
      },
    });
    const fn = vi.fn();
    try {
      await expect(
        api.run(fn, scoped ? { scopes: { recipient: 'A' } } : {}),
      ).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
      expect(fn).not.toHaveBeenCalled();
      expect(api.stats().queued).toBe(0);
      await api.idle();
    } finally {
      await api.close();
      await backing.close();
    }
  },
);
