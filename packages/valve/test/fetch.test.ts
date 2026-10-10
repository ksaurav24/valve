// Fetch retries, slot release, bodies, request cloning, and a real HTTP server.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { createValve } from '../src/index.js';
import type { Valve } from '../src/index.js';
import { memoryStore } from '../src/index.js';
const valves: Valve[] = [];
const make: typeof createValve = (options) => {
  const valve = createValve(options);
  valves.push(valve);
  return valve;
};
afterEach(async () => {
  for (const valve of valves.splice(0)) await valve.close();
  vi.useRealTimers();
});
describe('fetch wrapping', () => {
  it.each(['invalid', '', ' ', '-1', 'Infinity', '1e3', '9'.repeat(308)])(
    'returns a 503 with unusable Retry-After %j without retrying or consuming its body',
    async (value) => {
      const response = new Response('unavailable', {
        status: 503,
        headers: { 'Retry-After': value },
      });
      const fake = vi.fn().mockResolvedValue(response);
      const valve = make({ id: 'invalid', concurrency: 1 });
      const pause = vi.fn();
      valve.on('pause', pause);
      expect(await valve.wrapFetch(fake)()).toBe(response);
      expect(fake).toHaveBeenCalledTimes(1);
      expect(pause).not.toHaveBeenCalled();
      expect(valve.stats().totals.retried).toBe(0);
      expect(await response.text()).toBe('unavailable');
    },
  );
  it.each(['0', 'Wed, 01 Jan 2020 00:00:00 GMT'])(
    'retries a 503 with valid zero-delay Retry-After %s',
    async (value) => {
      const first = new Response('', {
        status: 503,
        headers: { 'Retry-After': value },
      });
      const last = new Response('ok');
      const fake = vi.fn().mockResolvedValueOnce(first).mockResolvedValue(last);
      const valve = make({ id: 'zero', concurrency: 1 });
      const pause = vi.fn();
      valve.on('pause', pause);
      expect(await valve.wrapFetch(fake)()).toBe(last);
      expect(fake).toHaveBeenCalledTimes(2);
      expect(pause).not.toHaveBeenCalled();
      expect(valve.stats().totals.retried).toBe(1);
    },
  );
  it.each(['0.02', 'Wed, 07 Oct 2026 00:00:02 GMT', '999999999'])(
    'shares a capped 503 pause for Retry-After %s before retrying',
    async (value) => {
      vi.useFakeTimers();
      const store = memoryStore();
      const valve = make({ id: 'shared', concurrency: 1, store, maxPause: 20 });
      const peer = make({ id: 'shared', concurrency: 1, store });
      const pause = vi.fn();
      const warning = vi.fn();
      valve.on('pause', pause);
      valve.on('warning', warning);
      const first = new Response('', {
        status: 503,
        headers: {
          'Retry-After': value,
          Date: 'Wed, 07 Oct 2026 00:00:00 GMT',
        },
      });
      const last = new Response('ok');
      const fake = vi.fn().mockResolvedValueOnce(first).mockResolvedValue(last);
      const result = valve.wrapFetch(fake)();
      await vi.advanceTimersByTimeAsync(0);
      expect(pause).toHaveBeenCalledWith({
        durationMs: 20,
        reason: 'feedback',
      });
      expect(warning).toHaveBeenCalledTimes(value === '0.02' ? 0 : 1);
      expect(valve.stats().running).toBe(0);
      const next = vi.fn(() => 'peer');
      const concurrent = peer.run(next);
      await vi.advanceTimersByTimeAsync(19);
      expect(fake).toHaveBeenCalledTimes(1);
      expect(next).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(await result).toBe(last);
      expect(await concurrent).toBe('peer');
      expect(fake).toHaveBeenCalledTimes(2);
      expect(valve.stats().totals.retried).toBe(1);
    },
  );
  it.each([undefined, 'invalid', '', '0', 'Wed, 01 Jan 2020 00:00:00 GMT'])(
    'uses exponential 429 backoff without a positive Retry-After delay (%s)',
    async (value) => {
      vi.useFakeTimers();
      const response = new Response('', {
        status: 429,
        headers: value === undefined ? {} : { 'Retry-After': value },
      });
      const fake = vi.fn().mockResolvedValue(response);
      const valve = make({
        id: 'backoff',
        concurrency: 1,
        backoff: { base: 10, max: 100 },
      });
      const pause = vi.fn();
      valve.on('pause', pause);
      const result = valve.wrapFetch(fake)();
      await vi.advanceTimersByTimeAsync(9);
      expect(fake).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fake).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(19);
      expect(fake).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(await result).toBe(response);
      expect(fake).toHaveBeenCalledTimes(3);
      expect(pause.mock.calls.map(([event]) => event)).toEqual([
        { durationMs: 10, reason: 'backoff' },
        { durationMs: 20, reason: 'backoff' },
        { durationMs: 40, reason: 'backoff' },
      ]);
    },
  );
  it.each([429, 503])(
    'retries status %s, cancels unused bodies, and returns final response',
    async (status) => {
      vi.useFakeTimers();
      const cancel = vi.fn();
      const first = {
        status,
        headers: new Headers({ 'retry-after': '0.01' }),
        body: { cancel },
      };
      const last = new Response('ok');
      const fake = vi.fn().mockResolvedValueOnce(first).mockResolvedValue(last);
      const valve = make({ id: 'fetch', concurrency: 1 });
      const result = valve.wrapFetch(fake)('https://example.com');
      await vi.advanceTimersByTimeAsync(30);
      expect(await result).toBe(last);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(fake).toHaveBeenCalledTimes(2);
      expect(valve.stats().totals.retried).toBe(1);
    },
  );
  it('preserves retry sequence ahead of new requests and releases concurrency between attempts', async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    let count = 0;
    const fake = vi.fn(async (input: string) => {
      order.push(input);
      return new Response('', {
        status: ++count === 1 ? 429 : 200,
        headers: { 'retry-after': '0.01' },
      });
    });
    const valve = make({ id: 'fetch', concurrency: 1 });
    const limited = valve.wrapFetch(fake);
    const a = limited('a');
    await vi.advanceTimersByTimeAsync(0);
    expect(valve.stats().running).toBe(0);
    const b = limited('b');
    await vi.advanceTimersByTimeAsync(50);
    await Promise.all([a, b]);
    expect(order).toEqual(['a', 'a', 'b']);
  });
  it('returns the last 429 and never retries a stream body', async () => {
    const fake = vi.fn(async () => new Response('', { status: 429 }));
    const valve = make({ id: 'fetch', concurrency: 1, maxPause: 0 });
    const limited = valve.wrapFetch(fake, { retries: 1 });
    expect((await limited()).status).toBe(429);
    expect(fake).toHaveBeenCalledTimes(2);
    const f = vi.fn(async (input: string, init?: RequestInit) => {
      expect(input).toContain('example');
      expect(init?.body).toBeInstanceOf(ReadableStream);
      return new Response('', { status: 429 });
    });
    await valve.wrapFetch(f)('https://example.com', {
      body: new ReadableStream(),
    });
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('clones Request bodies and preserves init and abort signals', async () => {
    const valve = make({ id: 'fetch', concurrency: 1, maxPause: 0 });
    const bodies: string[] = [];
    let count = 0;
    const fake = vi.fn(async (input: Request) => {
      bodies.push(await input.text());
      return new Response('', { status: ++count === 1 ? 429 : 200 });
    });
    const original = new Request('https://example.com', {
      method: 'POST',
      body: 'payload',
    });
    await valve.wrapFetch(fake)(original);
    expect(bodies).toEqual(['payload', 'payload']);
    expect(original.bodyUsed).toBe(false);
    const controller = new AbortController();
    controller.abort('stop');
    const limited = valve.wrapFetch();
    await expect(
      limited('https://example.com', { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'ABORTED', cause: 'stop' });
  });
  it('supports cost/priority callbacks, maxWait, body cancellation errors, and custom response shapes', async () => {
    const valve = make({ id: 'fetch', concurrency: 1, maxPause: 0 });
    const fake = vi.fn(async (input: string) => ({
      status: input === 'a' && fake.mock.calls.length === 1 ? 429 : 200,
      headers: {},
      body: { cancel: () => Promise.reject(new Error('used')) },
    }));
    const limited = valve.wrapFetch(fake, {
      cost: () => 1,
      priority: () => 10,
      maxWait: 100,
    });
    expect((await limited('a')).status).toBe(200);
    expect(fake).toHaveBeenCalledTimes(2);
    expect(
      (await valve.wrapFetch(fake, { cost: 1, priority: 0 })('b')).status,
    ).toBe(200);
  });
  it('does not retry unrelated responses or fetch errors', async () => {
    const valve = make({ id: 'fetch', concurrency: 1 });
    const fake = vi.fn(async () => new Response('', { status: 503 }));
    expect((await valve.wrapFetch(fake)()).status).toBe(503);
    expect(fake).toHaveBeenCalledTimes(1);
    const error = new Error('network');
    await expect(
      valve.wrapFetch(async () => {
        throw error;
      })(),
    ).rejects.toBe(error);
  });
  it('validates wrapper configuration', () => {
    const valve = make({ id: 'fetch', concurrency: 1 });
    expect(() => valve.wrapFetch(undefined, { retries: -1 })).toThrow();
    expect(() => valve.wrapFetch(undefined, { maxWait: -1 })).toThrow();
    expect(() => valve.wrapFetch(1 as unknown as typeof fetch)).toThrow();
  });
  it('works with real fetch against a local server', async () => {
    let calls = 0;
    const server = createServer((_, res) => {
      res.writeHead(++calls === 1 ? 429 : 200, { 'Retry-After': '0.01' });
      res.end('body');
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('missing port');
    const valve = make({ id: 'real', concurrency: 1 });
    try {
      const response = await valve.wrapFetch()(
        `http://127.0.0.1:${address.port}`,
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('body');
      expect(calls).toBe(2);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
