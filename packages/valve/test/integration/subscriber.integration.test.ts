// Withhold real SUBSCRIBE replies while the separate Redis command client stays healthy.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { connect, createServer } from 'node:net';
import type { Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { Redis } from 'ioredis5';
import { createValve } from '../../src/index.js';
import type { Store, Valve } from '../../src/index.js';
import { redisStore } from '../../src/redis/index.js';
import { normalize } from '../../src/rules.js';

const binary = process.env.REDIS_SERVER_BIN;
const suite = binary ? describe : describe.skip;
suite('optional subscriber startup', () => {
  it('admits jobs with withheld subscription replies and restores notification wake-ups', async () => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const server = spawn(
      binary!,
      [
        '--bind',
        '127.0.0.1',
        '--port',
        String(port),
        '--save',
        '',
        '--appendonly',
        'no',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const sockets = new Set<Socket>();
    let hold = false;
    const buffered: Array<{ socket: Socket; data: Buffer }> = [];
    const proxy = createServer((downstream) => {
      const upstream = connect(port, '127.0.0.1');
      for (const socket of [downstream, upstream]) {
        sockets.add(socket);
        socket.on('error', () => undefined);
        socket.on('close', () => sockets.delete(socket));
      }
      downstream.pipe(upstream);
      upstream.on('data', (data: Buffer) => {
        if (hold) buffered.push({ socket: downstream, data });
        else downstream.write(data);
      });
    });
    function releaseReplies() {
      hold = false;
      for (const { socket, data } of buffered.splice(0)) socket.write(data);
    }
    const client = new Redis({
      host: '127.0.0.1',
      port,
      lazyConnect: true,
      retryStrategy: () => null,
    });
    let subscriber: Redis | undefined;
    let store: Store | undefined;
    let valve: Valve | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.once('exit', (code) =>
          reject(new Error(`Redis exited before becoming ready: ${code}`)),
        );
        server.stdout!.on('data', (chunk) => {
          if (String(chunk).includes('Ready to accept')) resolve();
        });
      });
      proxy.listen(0, '127.0.0.1');
      await once(proxy, 'listening');
      subscriber = new Redis({
        host: '127.0.0.1',
        port: (proxy.address() as { port: number }).port,
        lazyConnect: true,
        retryStrategy: () => null,
      });
      await Promise.all([client.connect(), subscriber.connect()]);
      hold = true;
      store = redisStore({ client, subscriber, timeout: 1000 });
      const id = 'subscriber-hang';
      const rate = { limit: 10, interval: '1s' } as const;
      expect(
        (
          await store.acquire({
            id: 'probe',
            rules: normalize({ id, rate }).rules,
            costs: [1],
          })
        ).granted,
      ).toBe(1);
      let subscribed = false;
      const subscribe = store.subscribe!;
      const ready = new Promise<void>((resolve, reject) => {
        valve = createValve({
          id,
          rate,
          maxWait: 1000,
          store: {
            ...store!,
            subscribe: (key, listener) => {
              return Promise.resolve(subscribe(key, listener)).then(
                (off) => {
                  subscribed = true;
                  resolve();
                  return off;
                },
                (error) => {
                  reject(error);
                  throw error;
                },
              );
            },
          },
        });
      });
      await expect(valve!.run(() => 42)).resolves.toBe(42);
      await delay(20);
      expect(buffered.length).toBeGreaterThan(0);
      expect(subscribed).toBe(false);
      expect(await client.ping()).toBe('PONG');
      expect(valve!.stats().totals.storeErrors).toBe(0);

      // Redis enforces pauses even without pub/sub. Once recovered, resume
      // notifications must wake a job well before the original pause expires.
      await store.pause(id, 5000);
      const paused = valve!.run(() => 43);
      const completed = expect(paused).resolves.toBe(43);
      for (
        let attempt = 0;
        attempt < 100 && !valve!.stats().pausedUntil;
        attempt++
      )
        await delay(5);
      expect(valve!.stats().pausedUntil).not.toBeNull();
      expect(valve!.stats().totals.started).toBe(1);
      releaseReplies();
      await ready;
      await store.resume(id);
      await completed;
      expect(valve!.stats().totals.started).toBe(2);
      expect(valve!.stats().totals.storeErrors).toBe(0);
    } finally {
      releaseReplies();
      await valve?.close();
      await store?.close();
      client.disconnect();
      subscriber?.disconnect();
      for (const socket of sockets) socket.destroy();
      if (proxy.listening)
        await new Promise<void>((resolve) => proxy.close(() => resolve()));
      if (server.exitCode === null) {
        const exited = once(server, 'exit');
        server.kill('SIGTERM');
        await exited;
      }
    }
  });
});
