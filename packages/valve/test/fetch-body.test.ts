// Native uploads exercise bounded Request replay, backpressure, and aborts.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createValve, memoryStore } from '../src/index.js';
import type { Valve } from '../src/index.js';

const valves: Valve[] = [];
const make: typeof createValve = (options) => {
  const valve = createValve(options);
  valves.push(valve);
  return valve;
};
afterEach(async () => {
  for (const valve of valves.splice(0)) await valve.close();
  vi.restoreAllMocks();
});

async function uploadServer(retryAfter = '0') {
  const uploads: { bytes: number; hash: string }[] = [];
  const sockets = new Set();
  const server = createServer(async (req, res) => {
    sockets.add(req.socket);
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      hash.update(chunk);
    }
    uploads.push({ bytes, hash: hash.digest('hex') });
    res.writeHead(uploads.length === 1 ? 429 : 200, {
      'Retry-After': retryAfter,
    });
    res.end('provider body');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing port');
  return {
    url: `http://127.0.0.1:${address.port}`,
    uploads,
    sockets,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function streamedRequest(
  url: string,
  body: ReadableStream<Uint8Array>,
  init: RequestInit = {},
) {
  return new Request(url, {
    method: 'PUT',
    body,
    duplex: 'half',
    ...init,
  } as RequestInit);
}

describe('Request body replay limits', () => {
  it.each(['PUT', 'POST'])(
    'sends a 16 MiB streamed %s once and stops probing before draining it',
    async (method) => {
      const server = await uploadServer();
      let pulls = 0;
      const cancel = vi.fn();
      const expected = createHash('sha256');
      for (let i = 0; i < 256; i++)
        expected.update(new Uint8Array(64 * 1024).fill(i));
      const request = streamedRequest(
        server.url,
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(64 * 1024).fill(pulls++));
            if (pulls === 256) controller.close();
          },
          cancel,
        }),
        { method, headers: { 'Content-Length': String(16 * 1024 * 1024) } },
      );
      const clone = vi.spyOn(request, 'clone');
      let pullsAtFetch = 0;
      const impl: typeof fetch = (input, init) => {
        pullsAtFetch = pulls;
        return fetch(input, init);
      };
      const valve = make({ id: 'large', concurrency: 1 });
      try {
        const result = await valve.wrapFetch(impl, {
          retries: 2,
          retryUnsafeMethods: method === 'POST',
        })(request);
        expect(result.status).toBe(429);
        expect(await result.text()).toBe('provider body');
        expect(server.uploads).toEqual([
          { bytes: 16 * 1024 * 1024, hash: expected.digest('hex') },
        ]);
        expect(pullsAtFetch).toBeLessThan(10);
        expect(pulls).toBe(256);
        expect(request.bodyUsed).toBe(true);
        expect(cancel).not.toHaveBeenCalled();
        expect(valve.stats().totals.retried).toBe(0);
        const probe = clone.mock.results[0]!.value as Request;
        const discarded = probe.body!.getReader();
        expect(await discarded.read()).toEqual({
          done: true,
          value: undefined,
        });
        discarded.releaseLock();
      } finally {
        await server.close();
      }
    },
  );

  it.each([65535, 65536, 65537])(
    'replays byte bodies only through the default 64 KiB boundary (%i bytes)',
    async (size) => {
      const server = await uploadServer();
      const payload = new Uint8Array(size).fill(42);
      const request = new Request(server.url, { method: 'PUT', body: payload });
      const valve = make({ id: 'boundary', concurrency: 1 });
      try {
        const result = await valve.wrapFetch()(request);
        const replayed = size <= 65536;
        expect(result.status).toBe(replayed ? 200 : 429);
        expect(server.uploads).toHaveLength(replayed ? 2 : 1);
        expect(server.uploads.every((upload) => upload.bytes === size)).toBe(
          true,
        );
        expect(new Set(server.uploads.map((upload) => upload.hash)).size).toBe(
          1,
        );
        expect(request.bodyUsed).toBe(!replayed);
        expect(valve.stats().totals.retried).toBe(replayed ? 1 : 0);
      } finally {
        await server.close();
      }
    },
  );

  it('replays a small slow stream identically and allows a later connection reuse', async () => {
    const server = await uploadServer('0.01');
    let pulls = 0;
    const request = streamedRequest(
      server.url,
      new ReadableStream({
        async pull(controller) {
          await new Promise((resolve) => setTimeout(resolve, 2));
          controller.enqueue(new Uint8Array(1024).fill(pulls++));
          if (pulls === 4) controller.close();
        },
      }),
    );
    const valve = make({ id: 'slow', concurrency: 1 });
    try {
      const result = await valve.wrapFetch()(request);
      expect(result.status).toBe(200);
      await result.text();
      expect(server.uploads).toHaveLength(2);
      expect(server.uploads[0]!.bytes).toBe(4096);
      const expected = createHash('sha256');
      for (let i = 0; i < 4; i++) expected.update(new Uint8Array(1024).fill(i));
      expect(server.uploads[0]!.hash).toBe(expected.digest('hex'));
      expect(server.uploads[0]).toEqual(server.uploads[1]);
      expect(pulls).toBe(4);
      expect(request.bodyUsed).toBe(false);
      // A later call may reuse either pooled connection; do not require that
      // undici reuse the first one immediately after response cancellation.
      await new Promise((resolve) => setTimeout(resolve, 20));
      const connections = server.sockets.size;
      await (await valve.wrapFetch()(server.url)).text();
      expect(server.sockets.size).toBe(connections);
    } finally {
      await server.close();
    }
  });

  it('does not probe when Request replay is disabled', async () => {
    const request = streamedRequest(
      'https://example.com',
      new ReadableStream(),
    );
    const clone = vi.spyOn(request, 'clone');
    const impl = vi.fn<typeof fetch>(
      async () => new Response('limited', { status: 429 }),
    );
    const valve = make({ id: 'disabled', concurrency: 1, maxPause: 0 });
    await valve.wrapFetch(impl, { maxReplayBodySize: 0 })(request);
    expect(clone).not.toHaveBeenCalled();
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it('honors a configured byte limit and counts bytes rather than characters', async () => {
    const valve = make({ id: 'bytes', concurrency: 1, maxPause: 0 });
    for (const limit of [3, 4]) {
      const bodies: string[] = [];
      const impl = vi.fn<typeof fetch>(async (input) => {
        bodies.push(await (input as Request).text());
        return new Response('', { status: bodies.length === 1 ? 429 : 200 });
      });
      const request = new Request('https://example.com', {
        method: 'PUT',
        body: '💧',
      });
      await valve.wrapFetch(impl, { maxReplayBodySize: limit })(request);
      expect(bodies).toEqual(limit === 4 ? ['💧', '💧'] : ['💧']);
    }
  });

  it('retries an init body override without reading the inherited body', async () => {
    const server = await uploadServer();
    const request = streamedRequest(server.url, new ReadableStream());
    const clone = vi.spyOn(request, 'clone');
    const valve = make({ id: 'override', concurrency: 1 });
    try {
      const result = await valve.wrapFetch()(request, { body: 'replacement' });
      expect(result.status).toBe(200);
      expect(server.uploads).toHaveLength(2);
      expect(server.uploads[0]).toEqual(server.uploads[1]);
      expect(server.uploads[0]!.bytes).toBe(11);
      expect(request.bodyUsed).toBe(false);
      expect(clone).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('never retries a direct init stream, including a Request body override', async () => {
    const server = await uploadServer();
    const request = new Request(server.url, { method: 'PUT', body: 'unused' });
    const clone = vi.spyOn(request, 'clone');
    const valve = make({ id: 'direct', concurrency: 1 });
    try {
      const response = await valve.wrapFetch()(request, {
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]));
            controller.close();
          },
        }),
        duplex: 'half',
      } as RequestInit);
      expect(response.status).toBe(429);
      expect(server.uploads).toHaveLength(1);
      expect(server.uploads[0]!.bytes).toBe(3);
      expect(clone).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('does not clone or send a pre-aborted Request', async () => {
    const server = await uploadServer();
    const controller = new AbortController();
    controller.abort('stop');
    const request = new Request(server.url, {
      method: 'PUT',
      body: 'payload',
      signal: controller.signal,
    });
    const clone = vi.spyOn(request, 'clone');
    const valve = make({ id: 'pre-abort', concurrency: 1 });
    try {
      await expect(valve.wrapFetch()(request)).rejects.toMatchObject({
        code: 'ABORTED',
        cause: 'stop',
      });
      expect(server.uploads).toHaveLength(0);
      expect(clone).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('aborts a pending body probe and releases its concurrency slot', async () => {
    const controller = new AbortController();
    const request = streamedRequest(
      'https://example.com',
      new ReadableStream(),
      {
        signal: controller.signal,
      },
    );
    const valve = make({ id: 'probe-abort', concurrency: 1 });
    const impl = vi.fn<typeof fetch>();
    const result = valve.wrapFetch(impl)(request);
    const rejected = expect(result).rejects.toBe('stop');
    await vi.waitFor(() => expect(request.body!.locked).toBe(false));
    await vi.waitFor(() => expect(valve.stats().running).toBe(1));
    controller.abort('stop');
    await rejected;
    expect(await valve.run(() => 'next')).toBe('next');
    expect(impl).not.toHaveBeenCalled();
  });

  it('aborts during a real cooldown without a second upload', async () => {
    const server = await uploadServer('1');
    const controller = new AbortController();
    const request = streamedRequest(
      server.url,
      new ReadableStream({
        start(stream) {
          stream.enqueue(new Uint8Array(1024));
          stream.close();
        },
      }),
      { signal: controller.signal },
    );
    const valve = make({ id: 'cooldown-abort', concurrency: 1 });
    const result = valve.wrapFetch()(request);
    const rejected = expect(result).rejects.toMatchObject({
      code: 'ABORTED',
      cause: 'stop',
    });
    try {
      await vi.waitFor(() => {
        expect(valve.stats().totals.retried).toBe(1);
        expect(valve.stats().queued).toBe(1);
      });
      controller.abort('stop');
      await rejected;
      expect(server.uploads).toHaveLength(1);
    } finally {
      controller.abort('cleanup');
      await server.close();
    }
  });

  it('propagates an abort during a slow oversized upload without retrying', async () => {
    const controller = new AbortController();
    let calls = 0;
    let bytes = 0;
    const server = createServer((req) => {
      calls++;
      req.on('error', () => {}); // Native fetch closes an aborted upload.
      req.on('data', (chunk) => {
        bytes += chunk.length;
        controller.abort();
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('missing port');
    let pulls = 0;
    const request = streamedRequest(
      `http://127.0.0.1:${address.port}`,
      new ReadableStream({
        async pull(stream) {
          if (pulls > 0)
            await new Promise((resolve) => setTimeout(resolve, 20));
          // Sources must honor the caller's signal, as with native fetch.
          if (controller.signal.aborted) {
            stream.close();
            return;
          }
          stream.enqueue(new Uint8Array(128 * 1024));
          if (++pulls === 128) stream.close();
        },
      }),
      { signal: controller.signal },
    );
    const valve = make({ id: 'upload-abort', concurrency: 1 });
    try {
      await expect(valve.wrapFetch()(request)).rejects.toMatchObject({
        name: 'AbortError',
      });
      expect(calls).toBe(1);
      expect(bytes).toBeGreaterThan(0);
      expect(bytes).toBeLessThan(16 * 1024 * 1024);
      expect(valve.stats().totals.retried).toBe(0);
    } finally {
      controller.abort();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('does not probe a Request while waiting for admission', async () => {
    const request = new Request('https://example.com', {
      method: 'PUT',
      body: 'payload',
    });
    const clone = vi.spyOn(request, 'clone');
    const valve = make({ id: 'queued', concurrency: 1, maxWait: 10 });
    let release!: () => void;
    const blocked = valve.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await vi.waitFor(() => expect(valve.stats().running).toBe(1));
    await expect(valve.wrapFetch()(request)).rejects.toMatchObject({
      code: 'MAX_WAIT_EXCEEDED',
    });
    expect(clone).not.toHaveBeenCalled();
    release();
    await blocked;
  });

  it.each(['failed', 'hung'])(
    'settles a stalled probe when global lease renewal is %s',
    async (mode) => {
      const memory = memoryStore();
      const release = vi.fn(memory.release!);
      const valve = make({
        id: 'lease-probe',
        concurrency: { scope: 'global', limit: 1, leaseTtl: 30 },
        store: {
          ...memory,
          release,
          renew: () =>
            mode === 'failed'
              ? Promise.resolve(false)
              : new Promise<boolean>(() => {}),
        },
      });
      const request = streamedRequest(
        'https://example.com',
        new ReadableStream(),
      );
      const impl = vi.fn<typeof fetch>();
      await expect(valve.wrapFetch(impl)(request)).rejects.toMatchObject({
        code: 'LEASE_LOST',
      });
      expect(impl).not.toHaveBeenCalled();
      expect(request.signal.aborted).toBe(false);
      await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
      expect(await valve.run(() => 'next')).toBe('next');
    },
  );

  it.each([-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])(
    'rejects an invalid replay byte limit %s',
    (maxReplayBodySize) => {
      const valve = make({ id: 'invalid-limit', concurrency: 1 });
      expect(() => valve.wrapFetch(undefined, { maxReplayBodySize })).toThrow(
        /maxReplayBodySize/,
      );
    },
  );

  it('passes body source errors through without fetching or retrying', async () => {
    const error = new Error('source failed');
    const request = streamedRequest(
      'https://example.com',
      new ReadableStream({
        pull(controller) {
          controller.error(error);
        },
      }),
    );
    const valve = make({ id: 'source-error', concurrency: 1 });
    const impl = vi.fn<typeof fetch>();
    await expect(valve.wrapFetch(impl)(request)).rejects.toMatchObject({
      message: 'source failed',
    });
    expect(impl).not.toHaveBeenCalled();
  });

  it('bounds empty chunk queues even when they do not use the byte budget', async () => {
    let pulls = 0;
    const request = streamedRequest(
      'https://example.com',
      new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array());
          if (++pulls === 100000) controller.close();
        },
      }),
    );
    const valve = make({ id: 'empty-chunks', concurrency: 1, maxPause: 0 });
    const clone = vi.spyOn(request, 'clone');
    let pullsAtFetch = 0;
    const impl = vi.fn<typeof fetch>(async (input) => {
      pullsAtFetch = pulls;
      await (input as Request).arrayBuffer();
      return new Response('', { status: 429 });
    });
    await valve.wrapFetch(impl, { maxReplayBodySize: 1 })(request);
    expect(pullsAtFetch).toBeLessThan(1030);
    expect(pulls).toBe(100000);
    expect(impl).toHaveBeenCalledTimes(1);
    const probe = clone.mock.results[0]!.value as Request;
    const discarded = probe.body!.getReader();
    expect(await discarded.read()).toEqual({ done: true, value: undefined });
    discarded.releaseLock();
  });

  it('passes invalid stream chunks to the client without probing an unbounded source', async () => {
    const request = streamedRequest(
      'https://example.com',
      new ReadableStream({
        pull(controller) {
          controller.enqueue('invalid' as unknown as Uint8Array);
        },
      }),
    );
    const valve = make({ id: 'invalid-chunks', concurrency: 1 });
    const impl = vi.fn<typeof fetch>(async (input) => {
      await (input as Request).arrayBuffer();
      return new Response('ok');
    });
    await expect(valve.wrapFetch(impl)(request)).rejects.toThrow();
    expect(impl).toHaveBeenCalledTimes(1);
  });
});
