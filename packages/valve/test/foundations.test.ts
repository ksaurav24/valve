// Duration, validation, queue, emitter, and shared memory-store invariants.
import { describe, expect, it, vi } from 'vitest';
import { duration } from '../src/duration.js';
import {
  createValve,
  isValveError,
  memoryStore,
  ValveError,
} from '../src/index.js';
import { normalize } from '../src/rules.js';
import { JobQueue } from '../src/queue.js';
import type { Queued } from '../src/queue.js';
import { emitter } from '../src/emitter.js';
import type { Duration, ValveOptions } from '../src/index.js';

describe('durations and validation', () => {
  it.each([
    [250, 250],
    ['1ms', 1],
    ['.5s', 500],
    ['1.5s', 1500],
    ['2m', 120000],
    ['24h', 86400000],
    [0, 0],
  ] as const)('parses %s', (input, output) =>
    expect(duration(input)).toBe(output),
  );
  it.each([
    -1,
    NaN,
    Infinity,
    '1d',
    'abc',
    '-1s',
    '',
    '1 s',
    '1e3s',
    Number.MAX_SAFE_INTEGER * 2,
  ])('rejects %s', (value) =>
    expect(() => duration(value as Duration)).toThrow(ValveError),
  );
  it.each([
    { id: '' },
    { id: '{x}' },
    { id: 'x'.repeat(201) },
    { id: 5 },
    { rate: [] },
    { rate: null },
    { rate: { limit: 0, interval: '1s' } },
    { rate: { limit: 1.5, interval: '1s' } },
    { rate: { limit: 1, interval: 0 } },
    { rate: { limit: 1, interval: 'bad' } },
    { rate: { limit: 1, interval: '1s', burst: 0 } },
    { rate: { limit: 1, interval: '1s', algorithm: 'bad' } },
    { concurrency: 0 },
    { concurrency: 1.5 },
    { maxQueue: 0 },
    { batch: 0 },
    { maxWait: -1 },
    { maxPause: Infinity },
    { backoff: { base: '2s', max: '1s' } },
    { onStoreError: 'bad' },
    { feedback: 1 },
    { store: {} },
  ])('rejects invalid configuration %j', (changes) =>
    expect(() =>
      createValve({
        id: 'hubspot',
        rate: { limit: 1, interval: '1s' },
        ...changes,
      } as ValveOptions),
    ).toThrow(ValveError),
  );
  it('requires a rate or finite concurrency', () => {
    expect(() => createValve({ id: 'x' })).toThrow();
    expect(() => createValve({ id: 'x', concurrency: Infinity })).toThrow();
    expect(createValve({ id: 'x', concurrency: 1 }).id).toBe('x');
  });
  it('matches exact error messages', () => {
    expect(() =>
      createValve({ id: 'hubspot', rate: { limit: 0, interval: '10s' } }),
    ).toThrow(
      'valve("hubspot"): rate[0].limit must be a positive integer. Got 0. Use the number of requests the provider allows per interval.',
    );
    expect(() =>
      createValve({
        id: 'hubspot',
        rate: [
          { limit: 1, interval: '10s' },
          { limit: 2, interval: 10000 },
        ],
      }),
    ).toThrow(
      'valve("hubspot"): two rules use algorithm gcra with interval 10000ms. Merge them into one rule.',
    );
  });
  it('normalizes fixed-window burst and defaults', () => {
    const result = normalize({
      id: 'x',
      rate: [
        { limit: 2, interval: '1s', algorithm: 'fixed-window', burst: 10 },
      ],
    });
    expect(result.rules[0]).toEqual({
      algorithm: 'fixed-window',
      limit: 2,
      intervalMs: 1000,
      burst: 1,
      key: 'fixed-window:1000',
    });
  });
  it('guards codes and preserves causes', () => {
    const cause = new Error('source');
    const error = new ValveError('CLOSED', 'closed', { valveId: 'x', cause });
    expect(error.name).toBe('ValveError');
    expect(error.cause).toBe(cause);
    expect(isValveError(error)).toBe(true);
    expect(isValveError(error, 'CLOSED')).toBe(true);
    expect(isValveError(error, 'ABORTED')).toBe(false);
    expect(isValveError(cause)).toBe(false);
    expect(new ValveError('CLOSED', 'x').valveId).toBeUndefined();
  });
});

describe('queue', () => {
  const job = (seq: number, priority = 0): Queued => ({
    seq,
    priority,
    state: 'queued',
  });
  it('preserves FIFO ties and promotes to heap', () => {
    const q = new JobQueue<Queued>();
    const a = job(0);
    q.push(a);
    q.push(job(1));
    q.push(job(2, 10));
    q.push(job(3, -1));
    q.push(job(4, 10));
    expect(q.take(10).map((j) => j.seq)).toEqual([2, 4, 0, 1, 3]);
    expect(q.size).toBe(0);
    q.push(job(5));
    expect(q.take(1)[0]?.seq).toBe(5);
  });
  it('lazily removes cancelled jobs in ring and heap', () => {
    const q = new JobQueue<Queued>();
    const a = job(0);
    q.push(a);
    q.cancel(a);
    q.cancel(a);
    q.push(job(1));
    expect(q.take(1).map((j) => j.seq)).toEqual([1]);
    const b = job(2, 2);
    q.push(b);
    q.push(job(3, 3));
    q.cancel(b);
    expect(q.take(9).map((j) => j.seq)).toEqual([3]);
  });
  it('compacts long FIFO queues and orders a deep heap', () => {
    const q = new JobQueue<Queued>();
    for (let i = 0; i < 3000; i++) q.push(job(i));
    expect(q.take(2000)).toHaveLength(2000);
    expect(q.take(2000).at(-1)?.seq).toBe(2999);
    for (let i = 0; i < 100; i++) q.push(job(i, i % 7));
    const out = q.take(100);
    for (let i = 1; i < out.length; i++)
      expect(out[i - 1]!.priority).toBeGreaterThanOrEqual(out[i]!.priority);
  });
});

describe('events', () => {
  it('orders listeners, unsubscribes, catches listener errors and warning errors', () => {
    const e = emitter();
    const calls: number[] = [];
    const warning = vi.fn();
    const off = e.on('idle', () => calls.push(1));
    e.on('idle', () => {
      calls.push(2);
      throw new Error('bad');
    });
    e.on('warning', warning);
    e.on('warning', () => {
      throw new Error('also bad');
    });
    e.emit('idle', {});
    off();
    e.emit('idle', {});
    expect(calls).toEqual([1, 2, 2]);
    expect(warning).toHaveBeenCalledTimes(2);
  });
});

describe('memory store', () => {
  it('checks all rules atomically and preserves prefix grants', async () => {
    let now = 0;
    const store = memoryStore({ clock: () => now });
    const rules = normalize({
      id: 'x',
      rate: [
        { limit: 2, interval: 100, burst: 2 },
        { limit: 1, interval: 100, algorithm: 'fixed-window' },
      ],
    }).rules;
    expect(await store.acquire({ id: 'x', rules, costs: [1, 1] })).toEqual({
      granted: 1,
      retryAfterMs: 100,
      pausedMs: 0,
    });
    now = 100;
    expect(await store.acquire({ id: 'x', rules, costs: [1] })).toEqual({
      granted: 1,
      retryAfterMs: 0,
      pausedMs: 0,
    });
    await store.close();
  });
  it('extends pauses, resumes, isolates ids and sweeps expired states', async () => {
    let now = 10;
    const store = memoryStore({ clock: () => now });
    const rules = normalize({
      id: 'x',
      rate: { limit: 1, interval: 10 },
    }).rules;
    await store.pause('x', 100);
    await store.pause('x', 20);
    expect((await store.acquire({ id: 'x', rules, costs: [1] })).pausedMs).toBe(
      100,
    );
    expect(
      (await store.acquire({ id: 'other', rules, costs: [1] })).granted,
    ).toBe(1);
    await store.resume('x');
    expect((await store.acquire({ id: 'x', rules, costs: [1] })).granted).toBe(
      1,
    );
    await store.pause('expired', 1);
    now = 10000;
    for (let i = 0; i < 1030; i++)
      await store.acquire({ id: `id${i}`, rules, costs: [1] });
    expect((await store.acquire({ id: 'x', rules, costs: [1] })).granted).toBe(
      1,
    );
    await store.close();
  });
});
