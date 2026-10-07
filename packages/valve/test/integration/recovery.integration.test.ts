// Stop and restart an isolated real server to exercise outage policies.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { Redis } from 'ioredis5';
import { createValve } from '../../src/index.js';
import { redisStore } from '../../src/redis/index.js';
const binary = process.env.REDIS_SERVER_BIN;
const suite = binary ? describe : describe.skip;
suite('server restart', () => {
  it.each(['wait', 'open', 'throw'] as const)(
    'handles a stopped server with %s and reconnects',
    async (policy) => {
      const port = 19000 + (process.pid % 1000);
      let server: ChildProcess | undefined;
      const client = new Redis({
        host: '127.0.0.1',
        port,
        lazyConnect: true,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 0,
        retryStrategy: () => 20,
      });
      client.on('error', () => undefined);
      async function start() {
        server = spawn(
          binary!,
          [
            '--port',
            String(port),
            '--bind',
            '127.0.0.1',
            '--save',
            '',
            '--appendonly',
            'no',
          ],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        );
        await new Promise<void>((resolve, reject) => {
          server!.on('error', reject);
          server!.stdout!.on('data', (chunk) => {
            if (String(chunk).includes('Ready to accept')) resolve();
          });
        });
      }
      async function stop() {
        if (server && server.exitCode === null) {
          const done = once(server, 'exit');
          server.kill('SIGTERM');
          await done;
        }
      }
      await start();
      await client.connect();
      const api = createValve({
        id: `restart-${policy}`,
        rate: { limit: 10, interval: 1000, burst: 10 },
        store: redisStore({ client, timeout: 50 }),
        onStoreError: policy,
        maxWait: 5000,
      });
      try {
        expect(await api.run(() => 1)).toBe(1);
        await stop();
        const task = api.run(() => 2);
        const result =
          policy === 'throw'
            ? expect(task).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE' })
            : expect(task).resolves.toBe(2);
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(api.stats().totals.storeErrors).toBeGreaterThan(0);
        await start();
        for (
          let attempt = 0;
          attempt < 100 && client.status !== 'ready';
          attempt++
        )
          await new Promise((resolve) => setTimeout(resolve, 20));
        await result;
        expect(await api.run(() => 3)).toBe(3);
      } finally {
        await api.close();
        client.disconnect();
        await stop();
      }
    },
  );
});
