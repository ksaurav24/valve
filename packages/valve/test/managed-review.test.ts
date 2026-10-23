import { describe, expect, it, vi } from 'vitest';
import {
  createValve,
  memoryStore,
  type ManagedAcquireRequest,
  type ManagedAcquireResult,
  type ManagedScopedRequest,
  type ManagedScopedResult,
  type Store,
  type StoreNotification,
} from '../src/index.js';
import { normalize } from '../src/rules.js';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const waitFor = async (condition: () => boolean) => {
  await vi.waitFor(() => expect(condition()).toBe(true));
};

describe('managed numeric precision', () => {
  it('rechecks precision after a request getter changes authoritative limits', async () => {
    let now = 0;
    const store = memoryStore({ clock: () => now });
    const id = 'reentrant-precision';
    const rules = normalize({
      id,
      limits: 'managed',
      rate: { name: 'r', limit: 1, interval: 1, burst: 1 },
    }).rules;
    await store.managed!.getLimits({ id, rules });
    let update: Promise<unknown> | undefined;
    try {
      expect(() =>
        store.managed!.acquireSync!({
          id,
          rules,
          costs: [1],
          get known() {
            now = 1e12;
            update = store.managed!.updateLimits({
              id,
              rules,
              patch: { r: { limit: 1e9 } },
            });
            return '0.0';
          },
        }),
      ).toThrowError(expect.objectContaining({ code: 'INVALID_OPTIONS' }));
      await expect(update).resolves.toMatchObject({
        rules: { r: { limit: 1e9 } },
      });
    } finally {
      await store.close();
    }
  });

  it('fails closed before an unsafe high-rate frame can grant twice at one instant', async () => {
    let now = 0;
    const store = memoryStore({ clock: () => now });
    const rules = normalize({
      id: 'precision-collapse',
      limits: 'managed',
      rate: { name: 'r', limit: 1, interval: 1, burst: 1 },
    }).rules;

    let updateRejected = false;
    try {
      await store.managed!.updateLimits({
        id: 'precision-collapse',
        rules,
        patch: { r: { limit: Number.MAX_SAFE_INTEGER } },
      });
    } catch (error) {
      expect(error).toMatchObject({ code: 'INVALID_OPTIONS' });
      updateRejected = true;
    }

    if (!updateRejected) {
      now = 10;
      expect(() =>
        store.managed!.acquireSync!({
          id: 'precision-collapse',
          rules,
          costs: [1, 1],
        }),
      ).toThrowError(expect.objectContaining({ code: 'INVALID_OPTIONS' }));
    }

    await store.close();
  });
});

describe('stale impossible managed admissions', () => {
  it('readmits a static job after a relaxing notice overtakes its async reply', async () => {
    const backing = memoryStore();
    const pending = deferred<ManagedAcquireResult>();
    let firstRequest: ManagedAcquireRequest | undefined;
    let staleResult: ManagedAcquireResult | undefined;
    let notify: ((notice: StoreNotification) => void) | undefined;
    const acquire = vi.fn((request: ManagedAcquireRequest) => {
      if (firstRequest) return backing.managed!.acquire(request);
      firstRequest = request;
      staleResult = backing.managed!.acquireSync!(request);
      expect(staleResult).toMatchObject({ granted: 0, impossible: true });
      return pending.promise;
    });
    const managed = { ...backing.managed! };
    delete managed.acquireSync;
    const store: Store = {
      ...backing,
      subscribe: (_id, listener) => {
        notify = listener;
        return () => {};
      },
      managed: { ...managed, acquire },
    };
    const valve = createValve({
      id: 'stale-static-impossible',
      rate: { name: 'r', limit: 1, interval: 1000, burst: 1 },
      limits: 'managed',
      store,
    });
    const callback = vi.fn(() => 'ran');
    const job = valve.run(callback, { cost: 2 });

    await waitFor(() => firstRequest !== undefined && notify !== undefined);
    const raised = await backing.managed!.updateLimits({
      id: firstRequest!.id,
      rules: firstRequest!.rules,
      patch: { r: { burst: 2 } },
    });
    notify!({ type: 'limits', version: raised.version, relaxed: true });
    pending.resolve(staleResult!);

    await expect(job).resolves.toBe('ran');
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenCalledTimes(1);
    await valve.close();
    await backing.close();
  });

  it('readmits a scoped job after a relaxing notice overtakes its async reply', async () => {
    const backing = memoryStore();
    const pending = deferred<ManagedScopedResult>();
    let firstRequest: ManagedScopedRequest | undefined;
    let staleResult: ManagedScopedResult | undefined;
    let notify: ((notice: StoreNotification) => void) | undefined;
    const acquireScoped = vi.fn((request: ManagedScopedRequest) => {
      if (firstRequest) return backing.managed!.acquireScoped!(request);
      firstRequest = request;
      staleResult = backing.managed!.acquireScopedSync!(request);
      expect(staleResult).toMatchObject({
        grantedIndexes: [],
        blocked: [{ index: 0, impossible: true }],
      });
      return pending.promise;
    });
    const managed = { ...backing.managed! };
    delete managed.acquireScopedSync;
    const store: Store = {
      ...backing,
      subscribe: (_id, listener) => {
        notify = listener;
        return () => {};
      },
      managed: { ...managed, acquireScoped },
    };
    const valve = createValve({
      id: 'stale-scoped-impossible',
      rate: {
        name: 'r',
        scope: 'account',
        limit: 1,
        interval: 1000,
        burst: 1,
      },
      limits: 'managed',
      store,
    });
    const callback = vi.fn(() => 'ran');
    const job = valve.run(callback, {
      cost: 2,
      scopes: { account: 'A' },
    });

    await waitFor(() => firstRequest !== undefined && notify !== undefined);
    const raised = await backing.managed!.updateLimits({
      id: firstRequest!.id,
      rules: firstRequest!.rules,
      patch: { r: { burst: 2 } },
    });
    notify!({ type: 'limits', version: raised.version, relaxed: true });
    pending.resolve(staleResult!);

    await expect(job).resolves.toBe('ran');
    expect(acquireScoped).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenCalledTimes(1);
    await valve.close();
    await backing.close();
  });
});

describe('malformed managed admission results', () => {
  it('rejects an out-of-range static grant under fail-open', async () => {
    const backing = memoryStore();
    const store: Store = {
      ...backing,
      managed: {
        ...backing.managed!,
        acquireSync: () => ({
          granted: 2,
          retryAfterMs: 0,
          pausedMs: 0,
        }),
      },
    };
    const valve = createValve({
      id: 'malformed-static-managed',
      rate: { name: 'r', limit: 1, interval: 1000 },
      limits: 'managed',
      onStoreError: 'open',
      store,
    });
    const callback = vi.fn();

    await expect(valve.run(callback)).rejects.toMatchObject({
      code: 'INVALID_OPTIONS',
    });
    expect(callback).not.toHaveBeenCalled();
    await valve.close();
    await backing.close();
  });

  it('rejects an incomplete scoped partition under fail-open', async () => {
    const backing = memoryStore();
    const store: Store = {
      ...backing,
      managed: {
        ...backing.managed!,
        acquireScopedSync: () => ({ grantedIndexes: [], blocked: [] }),
      },
    };
    const valve = createValve({
      id: 'malformed-scoped-managed',
      rate: {
        name: 'r',
        scope: 'account',
        limit: 1,
        interval: 1000,
      },
      limits: 'managed',
      onStoreError: 'open',
      store,
    });
    const callback = vi.fn();

    await expect(
      valve.run(callback, { scopes: { account: 'A' } }),
    ).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
    expect(callback).not.toHaveBeenCalled();
    await valve.close();
    await backing.close();
  });
});
