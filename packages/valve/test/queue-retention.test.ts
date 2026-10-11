// Cancelled queue storage stays bounded even when admission cannot progress.
import { describe, expect, it, vi } from 'vitest';
import { createValve, memoryStore } from '../src/index.js';
import type { AcquireResult } from '../src/index.js';
import { JobQueue } from '../src/queue.js';
import type { Queued } from '../src/queue.js';

const retained = (queue: JobQueue<Queued>): number =>
  (Reflect.get(queue, 'items') as Queued[]).length;
const job = (seq: number, priority = 0): Queued => ({
  seq,
  priority,
  state: 'queued',
});

describe('queue retention', () => {
  it('releases all references when the last queued job is cancelled', () => {
    const queue = new JobQueue<Queued>();
    for (let seq = 0; seq < 10_000; seq++) {
      const item = job(seq);
      queue.push(item);
      queue.cancel(item);
      queue.cancel(item);
    }
    expect(queue.size).toBe(0);
    expect(retained(queue)).toBe(0);
  });

  it.each([false, true])(
    'bounds tombstones with a live job (heap=%s)',
    (heap) => {
      const queue = new JobQueue<Queued>();
      const survivor = job(0);
      queue.push(survivor);
      let peak = 0;
      for (let seq = 1; seq <= 10_000; seq++) {
        const item = job(seq, heap ? 1 : 0);
        queue.push(item);
        queue.cancel(item);
        peak = Math.max(peak, retained(queue));
      }
      expect(queue.size).toBe(1);
      expect(peak).toBeLessThanOrEqual(1024);
      expect(queue.take(1)).toEqual([survivor]);
      expect(retained(queue)).toBe(0);
    },
  );

  it.each([false, true])(
    'preserves ordering after compaction (heap=%s)',
    (heap) => {
      const queue = new JobQueue<Queued>();
      const items = Array.from({ length: 3000 }, (_, seq) =>
        job(seq, heap ? seq % 7 : 0),
      );
      const ordered = [...items].sort(
        (a, b) => b.priority - a.priority || a.seq - b.seq,
      );
      for (const item of items) queue.push(item);
      // Taken jobs still have queued state while an async acquire is pending.
      expect(queue.take(500)).toEqual(ordered.slice(0, 500));
      for (const item of ordered.slice(500, 2500)) queue.cancel(item);
      expect(queue.size).toBe(500);
      expect(retained(queue)).toBeLessThanOrEqual(1024);
      expect(queue.take(1000)).toEqual(ordered.slice(2500));
      expect(retained(queue)).toBe(0);
      queue.push(job(3000));
      expect(queue.take(1)).toEqual([job(3000)]);
    },
  );

  it('bounds storage with maxQueue 1 while concurrency is occupied', async () => {
    const spy = vi.spyOn(JobQueue.prototype, 'push');
    const valve = createValve({
      id: 'cancel-retention',
      concurrency: 1,
      maxQueue: 1,
    });
    let finish!: () => void;
    const blocker = valve.run(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    const queue = spy.mock.contexts[0] as JobQueue<Queued>;
    try {
      expect(valve.stats().running).toBe(1);
      for (let i = 0; i < 10_000; i++) {
        const controller = new AbortController();
        const result = valve.run(() => 0, { signal: controller.signal });
        controller.abort();
        await expect(result).rejects.toMatchObject({ code: 'ABORTED' });
      }
      expect(retained(queue)).toBe(0);
    } finally {
      finish();
      await blocker;
      await valve.close();
      spy.mockRestore();
    }
  });

  it.each(['abort', 'deadline'])(
    'releases %s jobs during a blocked acquire',
    async (mode) => {
      vi.useFakeTimers();
      const store = memoryStore();
      delete store.acquireSync;
      let release!: (result: AcquireResult) => void;
      vi.spyOn(store, 'acquire').mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      const spy = vi.spyOn(JobQueue.prototype, 'cancel');
      const valve = createValve({
        id: 'blocked-acquire',
        concurrency: 1,
        store,
      });
      const controller = new AbortController();
      const fn = vi.fn();
      const results = Array.from({ length: 5000 }, () =>
        valve
          .run(
            fn,
            mode === 'abort' ? { signal: controller.signal } : { maxWait: 10 },
          )
          .catch((error: unknown) => error),
      );
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(store.acquire).toHaveBeenCalledTimes(1);
        if (mode === 'abort') controller.abort();
        else await vi.advanceTimersByTimeAsync(10);
        for (const result of await Promise.all(results))
          expect(result).toMatchObject({
            code: mode === 'abort' ? 'ABORTED' : 'MAX_WAIT_EXCEEDED',
          });
        const queue = spy.mock.contexts[0] as JobQueue<Queued>;
        expect(queue.size).toBe(0);
        expect(retained(queue)).toBe(0);
        const survivor = valve.run(() => 42);
        expect(queue.size).toBe(1);
        release({ granted: 1, retryAfterMs: 0, pausedMs: 0 });
        await vi.advanceTimersByTimeAsync(0);
        expect(await survivor).toBe(42);
        expect(fn).not.toHaveBeenCalled();
        expect(queue.size).toBe(0);
        expect(retained(queue)).toBe(0);
      } finally {
        release({ granted: 0, retryAfterMs: 0, pausedMs: 0 });
        await valve.close();
        spy.mockRestore();
        vi.useRealTimers();
      }
    },
  );
});
