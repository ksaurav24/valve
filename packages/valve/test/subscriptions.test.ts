// Subscription multiplexing, client families, errors, and resource ownership.
import { describe, expect, it, vi } from 'vitest';
import { subscriptions } from '../src/redis/subscriptions.js';
import { redisStore } from '../src/redis/index.js';
import { withLuaClock } from './lua-clock.js';
describe('subscriptions', () => {
  it('multiplexes node-redis listeners and removes only its own callback', async () => {
    let message!: (message: string | Uint8Array) => void;
    const subscriber = {
      subscribe: vi.fn(
        async (
          _channel: string,
          listener: (message: string | Uint8Array) => void,
        ) => {
          message = listener;
        },
      ),
      unsubscribe: vi.fn(async () => {}),
    };
    const hub = subscriptions(subscriber, 'prefix');
    const first = vi.fn(),
      second = vi.fn();
    const off = await hub.subscribe('x', first);
    await hub.subscribe('x', second);
    expect(subscriber.subscribe).toHaveBeenCalledTimes(1);
    message('pause:100');
    message('resume');
    message('release');
    message('garbage');
    message(new Uint8Array([1]));
    expect(first.mock.calls.map(([notice]) => notice.type)).toEqual([
      'pause',
      'resume',
      'release',
    ]);
    off();
    message('resume');
    expect(first).toHaveBeenCalledTimes(3);
    expect(second).toHaveBeenCalledTimes(4);
    await hub.close();
    expect(subscriber.unsubscribe).toHaveBeenCalledWith(
      'prefix:{x}:events',
      expect.any(Function),
    );
  });
  it('uses ioredis message events and cleans up its listener', async () => {
    let message!: (channel: string, message: string) => void;
    const subscriber = {
      on: vi.fn((_event: string, listener: typeof message) => {
        message = listener;
      }),
      off: vi.fn(),
      subscribe: vi.fn(async () => {}),
      unsubscribe: vi.fn(async () => {}),
    };
    const hub = subscriptions(subscriber, 'p');
    const listener = vi.fn();
    const off = await hub.subscribe('x', listener);
    message('p:{other}:events', 'resume');
    message('p:{x}:events', 'pause:10');
    off();
    message('p:{x}:events', 'resume');
    expect(listener).toHaveBeenCalledTimes(1);
    await hub.close();
    expect(subscriber.off).toHaveBeenCalledWith('message', message);
    expect(subscriber.unsubscribe).toHaveBeenCalledWith('p:{x}:events');
  });
  it('removes failed subscriptions and permits retry', async () => {
    const subscriber = {
      subscribe: vi
        .fn()
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValue(undefined),
      unsubscribe: vi.fn(async () => {}),
    };
    const hub = subscriptions(subscriber, 'p');
    await expect(hub.subscribe('x', vi.fn())).rejects.toThrow('offline');
    const off = await hub.subscribe('x', vi.fn());
    off();
    await hub.close();
  });
  it('validates separate connections and global Redis replies', async () => {
    const client = {
      evalsha: vi.fn().mockResolvedValue([1, 0, 0, ['token']]),
      eval: vi.fn(),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    };
    expect(() => redisStore({ client, subscriber: client })).toThrow(
      'separate connection',
    );
    const subscriber = {
      subscribe: vi.fn(async () => {}),
      unsubscribe: vi.fn(async () => {}),
    };
    const store = redisStore({ client, subscriber });
    const off = await store.subscribe!('x', vi.fn());
    off();
    const request = {
      id: 'x',
      rules: [],
      costs: [1],
      lease: { limit: 1, ttlMs: 100, owner: 'owner' },
    };
    expect(await store.acquire(request)).toEqual({
      granted: 1,
      retryAfterMs: 0,
      pausedMs: 0,
      leases: ['token'],
    });
    client.evalsha.mockResolvedValueOnce([1, 0, 0, []]);
    await expect(store.acquire(request)).rejects.toThrow('invalid lease');
    client.evalsha.mockResolvedValueOnce(1);
    await store.release!('x', ['token']);
    await store.release!('x', []);
    client.evalsha.mockResolvedValueOnce(1);
    expect(await store.renew!('x', ['token'], 100)).toBe(true);
    await store.close();
  });
  it('clock injection fails loudly after changes to the production clock', () => {
    expect(() => withLuaClock('local now = 0')).toThrow(
      'Production Lua clock changed',
    );
  });
});
