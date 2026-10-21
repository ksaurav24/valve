// Real-store progress across banked denials and lossy/reconnected subscriptions.
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { Redis } from 'ioredis5';
import { createValve } from '../../src/index.js';
import { redisStore } from '../../src/redis/index.js';
import { normalize } from '../../src/rules.js';
import type { Store } from '../../src/store.js';
const url = process.env.REDIS_URL;
const suite = url ? describe : describe.skip;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

suite('scheduler wakeups', () => {
  it('drains every banked worker under shared rate/lease limits with queued aborts and urgent deadlines', async () => {
    const client = new Redis(url!);
    const subscriber = client.duplicate();
    const prefix = `wakeups-${randomUUID()}`;
    const store = redisStore({ client, subscriber, prefix });
    const valves = Array.from({ length: 4 }, () =>
      createValve({
        id: 'fleet',
        store,
        rate: { limit: 100, interval: 1000, burst: 10 },
        concurrency: { limit: 4, scope: 'global', leaseTtl: 1000 },
      }),
    );
    let running = 0,
      peak = 0;
    const counts = [0, 0, 0, 0];
    try {
      const jobs = valves.flatMap((valve, worker) =>
        Array.from({ length: 12 }, () =>
          valve.run(async () => {
            peak = Math.max(peak, ++running);
            counts[worker]!++;
            await sleep(2);
            running--;
          }),
        ),
      );
      const controller = new AbortController();
      const cancelled = Promise.allSettled([
        valves[0]!.run(
          () => {
            throw new Error('aborted callback ran');
          },
          { signal: controller.signal },
        ),
      ]);
      controller.abort();
      const urgent = Promise.allSettled([
        valves[1]!.run(() => Date.now(), { priority: 10, maxWait: 15 }),
      ]);
      await Promise.all(jobs);
      expect(await cancelled).toMatchObject([
        { status: 'rejected', reason: { code: 'ABORTED' } },
      ]);
      const [outcome] = await urgent;
      if (outcome!.status === 'rejected')
        expect(outcome!.reason).toMatchObject({ code: 'MAX_WAIT_EXCEEDED' });
      expect(counts).toEqual([12, 12, 12, 12]);
      expect(peak).toBeLessThanOrEqual(4);
      expect(running).toBe(0);
    } finally {
      await Promise.all(valves.map((valve) => valve.close()));
      await store.close();
      const keys = await client.keys(`${prefix}:*`);
      if (keys.length) await client.del(...keys);
      subscriber.disconnect();
      client.disconnect();
    }
  });

  it.each(['drop', 'reconnect'] as const)(
    'makes progress after a dropped local echo and a foreign release (%s)',
    async (mode) => {
      const client = new Redis(url!);
      const subscriber = client.duplicate();
      const prefix = `release-${randomUUID()}`;
      const base = redisStore({ client, subscriber, prefix });
      let deliver = false;
      let notices = 0;
      const store: Store = {
        ...base,
        subscribe: (id, listener) =>
          base.subscribe!(id, (notice) => {
            notices++;
            if (deliver) listener(notice);
          }),
      };
      const valve = createValve({
        id: 'release',
        store,
        concurrency: { limit: 1, scope: 'global', leaseTtl: 10000 },
      });
      const rules = normalize({ id: 'release', concurrency: 1 }).rules;
      try {
        // Explicitly wait for subscription readiness; admission itself never does.
        const off = await base.subscribe!('release', () => undefined);
        await valve.run(() => 'local');
        await valve.idle();
        await expect.poll(() => notices).toBeGreaterThan(0);
        const foreign = await base.acquire({
          id: 'release',
          rules,
          costs: [1],
          lease: { limit: 1, ttlMs: 10000, owner: 'foreign' },
        });
        expect(foreign.granted).toBe(1);
        const job = Promise.allSettled([
          valve.run(() => 'progress', { maxWait: 2500 }),
        ]);
        await sleep(20);
        expect(valve.stats().queued).toBe(1);
        if (mode === 'reconnect') {
          const ended = once(subscriber, 'end');
          subscriber.disconnect();
          await ended;
          await subscriber.connect();
          // Confirm the same subscription can deliver again after reconnect.
          deliver = true;
        }
        const before = notices;
        await base.release!('release', foreign.leases!);
        // Drop mode relies entirely on the existing subscriber fallback poll.
        expect(await job).toEqual([{ status: 'fulfilled', value: 'progress' }]);
        if (mode === 'reconnect')
          await expect.poll(() => notices).toBeGreaterThan(before);
        off();
      } finally {
        await valve.close();
        await base.close();
        const keys = await client.keys(`${prefix}:*`);
        if (keys.length) await client.del(...keys);
        subscriber.disconnect();
        client.disconnect();
      }
    },
  );
});
