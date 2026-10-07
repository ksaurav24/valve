// Fetch retries, slot release, bodies, request cloning, and a real HTTP server.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { createValve } from '../src/index.js';
import type { Valve } from '../src/index.js';
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
