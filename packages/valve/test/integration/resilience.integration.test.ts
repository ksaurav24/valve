// Real Redis fault injection with bounded IPC waits and deterministic cleanup.
import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Redis } from 'ioredis5';
import { describe, expect, it } from 'vitest';
import { createValve } from '../../src/index.js';
import { redisStore } from '../../src/redis/index.js';
import type { Store } from '../../src/store.js';
import { RENEW } from '../../src/redis/scripts.js';

const url = process.env.REDIS_URL;
const suite = url ? describe : describe.skip;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

// Observer and replacement owners bypass the proxy. The command connection can
// lose a real renewal response without stopping Redis or other owners.
async function fixture() {
  const target = new URL(url!);
  const sockets = new Set<Socket>();
  let blocked = false;
  let holdResponses = false;
  const response = deferred<void>();
  const proxy = createServer((incoming) => {
    if (blocked) {
      incoming.destroy();
      return;
    }
    const upstream = createConnection({
      host: target.hostname,
      port: Number(target.port || 6379),
    });
    for (const socket of [incoming, upstream]) {
      sockets.add(socket);
      socket.on('error', () => undefined);
      socket.on('close', () => {
        sockets.delete(socket);
        incoming.destroy();
        upstream.destroy();
      });
    }
    incoming.pipe(upstream);
    upstream.on('data', (chunk) => {
      if (holdResponses) response.resolve();
      else incoming.write(chunk);
    });
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const address = proxy.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing proxy port');
  const prefix = `resilience-${process.pid}-${address.port}`;
  const id = 'owner';
  const key = `${prefix}:{${id}}:leases`;
  const observer = new Redis(url!, {
    lazyConnect: true,
    commandTimeout: 5000,
    connectTimeout: 2000,
    retryStrategy: (attempt) => (attempt < 100 ? 20 : null),
  });
  const proxyUrl = new URL(url!);
  observer.on('error', () => undefined);
  proxyUrl.hostname = '127.0.0.1';
  proxyUrl.port = String(address.port);
  const client = new Redis(proxyUrl.toString(), {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: null,
    commandTimeout: 5000,
    connectTimeout: 2000,
    retryStrategy: (attempt) => (attempt < 100 ? 20 : null),
  });
  client.on('error', () => undefined);
  const store = redisStore({ client, prefix, timeout: 100 });
  const healthy = redisStore({ client: observer, prefix });
  const children: ChildProcess[] = [];
  async function close() {
    // Kill and reap even workers blocked in Atomics.wait or callbacks.
    await Promise.all(
      children.map(async (child) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }),
    );
    client.disconnect();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await store.close();
    await healthy.close();
    try {
      const keys = await observer.keys(`${prefix}:*`);
      if (keys.length) await observer.del(...keys);
    } finally {
      observer.disconnect();
    }
  }
  try {
    await observer.connect();
    await observer.script('LOAD', RENEW);
    await client.connect();
  } catch (error) {
    await close();
    throw error;
  }
  return {
    prefix,
    id,
    key,
    observer,
    client,
    store,
    healthy,
    close,
    holdResponse() {
      holdResponses = true;
      return response.promise;
    },
    interrupt() {
      blocked = true;
      for (const socket of sockets) socket.destroy();
    },
    async restore() {
      blocked = holdResponses = false;
      await expect.poll(() => client.status, { timeout: 5000 }).toBe('ready');
      await client.ping();
    },
    worker(ttl: number, effectPath = '') {
      const child = fork(
        fileURLToPath(new URL('./resilience-worker.mjs', import.meta.url)),
        [url!, prefix, id, String(ttl), effectPath],
        { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
      );
      children.push(child);
      const messages: {
        type: string;
        admittedAt?: number;
        ok?: boolean;
        owners?: number;
        peak?: number;
        code?: string;
        aborted?: boolean;
        reason?: string;
      }[] = [];
      let stderr = '';
      child.stderr!.on('data', (chunk) => {
        stderr += String(chunk);
      });
      child.on('message', (message) =>
        messages.push(message as (typeof messages)[number]),
      );
      return {
        child,
        messages,
        send: (type: string, mode?: string) => child.send({ type, mode }),
        async exited() {
          await expect
            .poll(() => child.exitCode ?? child.signalCode, {
              timeout: 3000,
            })
            .not.toBeNull();
          expect(child.exitCode, stderr).toBe(0);
        },
        async wait(type: string) {
          await expect
            .poll(
              () => {
                if (
                  child.exitCode &&
                  !messages.some((message) => message.type === type)
                )
                  throw new Error(`Worker exited ${child.exitCode}: ${stderr}`);
                return messages.find((message) => message.type === type);
              },
              { timeout: 10000, interval: 10 },
            )
            .toBeDefined();
          return messages.find((message) => message.type === type)!;
        },
      };
    },
  };
}

suite('global lease resilience', () => {
  it('keeps a renewable limit of one across two independent processes', async () => {
    const f = await fixture();
    try {
      const workers = [f.worker(600), f.worker(600)];
      await Promise.all(workers.map((worker) => worker.wait('ready')));
      for (const worker of workers) worker.send('run', 'jobs');
      const results = await Promise.all(
        workers.map((worker) => worker.wait('result')),
      );
      for (const result of results)
        expect(result).toMatchObject({ ok: true, aborted: false });
      await Promise.all(workers.map((worker) => worker.exited()));
      for (const worker of workers) {
        const starts = worker.messages.filter(
          (message) => message.type === 'started',
        );
        expect(starts).toHaveLength(2);
        for (const start of starts)
          expect(start).toMatchObject({ owners: 1, peak: 1 });
      }
      expect(await f.observer.get(`${f.prefix}:{${f.id}}:peak`)).toBe('1');
      expect(await f.observer.get(`${f.prefix}:{${f.id}}:running`)).toBe('0');
    } finally {
      await f.close();
    }
  }, 20000);

  it('admits a replacement only after the killed owner expires on Redis', async () => {
    const f = await fixture();
    try {
      const owner = f.worker(1000);
      const replacement = f.worker(1000);
      await Promise.all([owner.wait('ready'), replacement.wait('ready')]);
      owner.send('run', 'hold');
      await owner.wait('started');
      const exited = once(owner.child, 'exit');
      owner.child.kill('SIGKILL');
      await exited;
      // Read after death: no renewal or release can change the recorded deadline.
      const leases = await f.observer.zrange(f.key, 0, -1, 'WITHSCORES');
      expect(leases).toHaveLength(2);
      replacement.send('run', 'hold');
      const started = await replacement.wait('started');
      expect(started.admittedAt).toBeGreaterThanOrEqual(Number(leases[1]));
      expect(started.owners).toBe(1);
      expect(await f.observer.zscore(f.key, leases[0]!)).toBeNull();
      replacement.send('finish');
      expect(await replacement.wait('result')).toMatchObject({
        ok: true,
        aborted: false,
      });
      await replacement.exited();
    } finally {
      await f.close();
    }
  }, 15000);

  it('surfaces lease loss at settlement after a stall, even though a synchronous effect ran', async () => {
    const f = await fixture();
    const directory = await mkdtemp(join(tmpdir(), 'valve-stall-'));
    const path = join(directory, 'effect');
    try {
      const owner = f.worker(600, path);
      const replacement = f.worker(600);
      await Promise.all([owner.wait('ready'), replacement.wait('ready')]);
      owner.send('run', 'hold');
      await owner.wait('started');
      replacement.send('run', 'hold');
      await replacement.wait('queued');
      owner.send('stall');
      await owner.wait('blocking');
      const leases = await f.observer.zrange(f.key, 0, -1, 'WITHSCORES');
      expect(leases).toHaveLength(2);
      const started = await replacement.wait('started');
      expect(started.admittedAt).toBeGreaterThanOrEqual(Number(leases[1]));
      expect(started.owners).toBe(1);
      expect(await owner.wait('effect')).toMatchObject({
        aborted: false,
      });
      expect(await readFile(path, 'utf8')).toBe(
        'effect after expired ownership',
      );
      expect(await owner.wait('result')).toMatchObject({
        ok: false,
        code: 'LEASE_LOST',
        aborted: true,
        reason: 'LEASE_LOST',
      });
      await owner.exited();
      expect(await f.observer.zcard(f.key)).toBe(1);
      replacement.send('finish');
      expect(await replacement.wait('result')).toMatchObject({
        ok: true,
        aborted: false,
      });
      await replacement.exited();
    } finally {
      await f.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 15000);

  it.each(['delayed', 'disconnected'] as const)(
    'loses ownership after a %s renewal response without touching a later token',
    async (fault) => {
      const f = await fixture();
      let attempted = false;
      const delivered = deferred<boolean>();
      const finish = deferred<number>();
      let signal: AbortSignal | undefined;
      let oldTokens: readonly string[] = [];
      const errors: unknown[] = [];
      const wrapped: Store = {
        ...f.store,
        async renew(id, tokens, ttlMs) {
          oldTokens = tokens;
          if (fault === 'delayed') {
            expect(await f.store.renew!(id, tokens, ttlMs)).toBe(true);
            attempted = true;
            return delivered.promise;
          }
          const response = f.holdResponse();
          const pending = f.store.renew!(id, tokens, ttlMs);
          void response.then(() => {
            f.interrupt();
            attempted = true;
          });
          return pending;
        },
      };
      const api = createValve({
        id: f.id,
        store: wrapped,
        concurrency: { limit: 1, scope: 'global', leaseTtl: 900 },
      });
      api.on('store-error', ({ error }) => errors.push(error));
      const task = api.run((context) => {
        signal = context.signal;
        return finish.promise;
      });
      let settled = false;
      const outcome = task
        .then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        )
        .finally(() => {
          settled = true;
        });
      try {
        await expect.poll(() => signal).toBeDefined();
        const initial = await f.observer.zrange(f.key, 0, -1, 'WITHSCORES');
        expect(initial).toHaveLength(2);
        const original = Number(initial[1]);
        await expect.poll(() => attempted, { timeout: 3000 }).toBe(true);
        const renewed = Number(await f.observer.zscore(f.key, oldTokens[0]!));
        expect(renewed).toBeGreaterThan(original);
        await expect.poll(() => signal?.aborted).toBe(true);
        expect(signal?.reason).toMatchObject({ code: 'LEASE_LOST' });
        expect(settled).toBe(false);
        if (fault === 'disconnected') expect(errors).toHaveLength(1);
        else expect(errors).toHaveLength(0);
        await expect.poll(() => f.observer.exists(f.key)).toBe(0);
        const replacement = await f.healthy.acquire({
          id: f.id,
          rules: [],
          costs: [1],
          lease: { limit: 1, ttlMs: 10000, owner: 'replacement' },
        });
        expect(replacement.granted).toBe(1);
        const replacementTokens = replacement.leases!;
        const score = await f.observer.zscore(f.key, replacementTokens[0]!);
        if (fault === 'disconnected') await f.restore();
        else delivered.resolve(true);
        expect(await f.store.renew!(f.id, oldTokens, 10000)).toBe(false);
        finish.resolve(42);
        expect(await outcome).toMatchObject({ error: { code: 'LEASE_LOST' } });
        await api.close(); // Flush the former owner's release before checking safety.
        expect(await f.observer.zrange(f.key, 0, -1)).toEqual([
          ...replacementTokens,
        ]);
        expect(await f.observer.zscore(f.key, replacementTokens[0]!)).toBe(
          score,
        );
      } finally {
        delivered.resolve(false);
        finish.resolve(42);
        try {
          await outcome;
          await api.close();
        } finally {
          await f.close();
        }
      }
    },
    15000,
  );

  it.each(['finite', 'infinite'] as const)(
    'drains an offline wait queue with %s maxWait',
    async (wait) => {
      const f = await fixture();
      const controller = new AbortController();
      const api = createValve({
        id: f.id,
        store: f.store,
        onStoreError: 'wait',
        concurrency: { limit: 1, scope: 'global', leaseTtl: 900 },
        ...(wait === 'finite' ? { maxWait: 500 } : {}),
      });
      let calls = 0;
      let closed = false;
      let settled = false;
      try {
        f.interrupt();
        await expect.poll(() => f.client.status).not.toBe('ready');
        const task = api.run(() => ++calls, { signal: controller.signal });
        const rejected = expect(task).rejects.toMatchObject({
          code: wait === 'finite' ? 'MAX_WAIT_EXCEEDED' : 'ABORTED',
        });
        void task.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        await expect
          .poll(() => api.stats().totals.storeErrors)
          .toBeGreaterThan(0);
        expect(api.stats().queued).toBe(1);
        expect(settled).toBe(false);
        const closing = api.close({ drain: true }).then(() => {
          closed = true;
        });
        if (wait === 'infinite') {
          await sleep(250);
          expect(closed).toBe(false);
          expect(settled).toBe(false);
          expect(api.stats().queued).toBe(1);
          controller.abort(new Error('shutdown deadline'));
        }
        await rejected;
        await closing;
        expect(calls).toBe(0);
        expect(api.stats().queued).toBe(0);
      } finally {
        controller.abort();
        await api.close();
        await f.close();
      }
    },
    10000,
  );
});
