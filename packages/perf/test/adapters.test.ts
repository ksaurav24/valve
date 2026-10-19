import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import type { AdapterContext } from '../src/adapters/types.ts';
import type { CellSpec } from '../src/core/types.ts';
import {
  adapterFor,
  CATEGORIES,
  competitorAdapters,
  naMatrix,
} from '../src/adapters/registry.ts';
import { bottleneckPriority } from '../src/adapters/bottleneck.ts';

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
function cellFor(id: string): CellSpec {
  return CATEGORIES.find((c) => c.id === id)!.buildCell();
}
function context(cell: CellSpec): AdapterContext {
  return {
    cell,
    worker: 0,
    instance: 0,
    quotaId: 'unused-local',
    keyPrefix: 'unused-local',
    valvePackageDir: '',
    onCall() {},
    now: () => performance.timeOrigin + performance.now(),
  };
}
describe('fair competitor adapters', () => {
  it('reads the installed versions', () => {
    expect(competitorAdapters.map((a) => a.version)).toEqual([
      'harness',
      '7.3.3',
      '9.3.3',
      '2.19.5',
    ]);
  });
  for (const adapter of competitorAdapters.filter((a) => a.id !== 'identity')) {
    it(`${adapter.id} L1 bounds actual running callbacks and releases failed slots`, async () => {
      const limiter = await adapter.create(context(cellFor('L1')));
      let running = 0;
      let peak = 0;
      try {
        const results = await Promise.allSettled(
          Array.from({ length: 12 }, (_, i) =>
            limiter.submit(
              async () => {
                peak = Math.max(peak, ++running);
                await sleep(12);
                running--;
                if (i === 2) throw new Error('expected job failure');
              },
              { cost: 1 },
            ),
          ),
        );
        expect(peak).toBe(2);
        expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
        expect(running).toBe(0);
      } finally {
        await limiter.close();
      }
    });
  }
  for (const id of ['p-queue', 'bottleneck'] as const) {
    it(`${id} L2 spaces starts`, async () => {
      const cell = cellFor('L2');
      cell.rules = [{ limit: 2, intervalMs: 100, burst: 1 }];
      const limiter = await adapterFor(id).create(context(cell));
      const starts: number[] = [];
      try {
        await Promise.all(
          Array.from({ length: 6 }, () =>
            limiter.submit(
              () => {
                starts.push(performance.now());
              },
              { cost: 1 },
            ),
          ),
        );
        // Bottleneck schedules from integer Date.now registration times through setTimeout
        // (lib/LocalDatastore.js:212-222, lib/Bottleneck.js:191-203). Actual callback
        // gaps include timer jitter; do not pad minTime to manufacture a stronger guarantee.
        const toleranceMs = id === 'bottleneck' ? 3 : 1;
        for (let i = 1; i < starts.length; i++)
          expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(
            50 - toleranceMs,
          );
      } finally {
        await limiter.close();
      }
    });
    it(`${id} L3 exhausts and refreshes windows without carrying running count`, async () => {
      const cell = cellFor('L3');
      cell.rules = [{ limit: 2, intervalMs: 500, algorithm: 'fixed-window' }];
      const limiter = await adapterFor(id).create(context(cell));
      const starts: number[] = [];
      try {
        await Promise.all(
          Array.from({ length: 6 }, () =>
            limiter.submit(
              () => {
                starts.push(performance.now());
              },
              { cost: 1 },
            ),
          ),
        );
        // Three saturated windows: no third start before the next refresh, anchored to creation/first start.
        expect(starts[2]! - starts[0]!).toBeGreaterThanOrEqual(480);
        expect(starts[4]! - starts[2]!).toBeGreaterThanOrEqual(480);
      } finally {
        await limiter.close();
      }
    });
    it(`${id} orders queued priorities higher-first`, async () => {
      const cell = cellFor('L1');
      cell.concurrency = 1;
      const limiter = await adapterFor(id).create(context(cell));
      let release!: () => void;
      let started!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const first = limiter.submit(
        async () => {
          started();
          await gate;
        },
        { cost: 1 },
      );
      await ready;
      const order: number[] = [];
      const jobs = [-1, 3, 1].map((priority) =>
        limiter.submit(
          () => {
            order.push(priority);
          },
          { cost: 1, priority },
        ),
      );
      // Bottleneck serializes submissions asynchronously; allow all three to enter its priority queue.
      await sleep(30);
      release();
      try {
        await Promise.all([first, ...jobs]);
        expect(order).toEqual([3, 1, -1]);
      } finally {
        await limiter.close();
      }
    });
  }
  it('p-queue L5 removes aborted queued jobs with structured ABORTED outcome', async () => {
    const cell = cellFor('L5');
    cell.concurrency = 1;
    const limiter = await adapterFor('p-queue').create(context(cell));
    const controller = new AbortController();
    let ran = false;
    const first = limiter.submit(() => sleep(40), { cost: 1 });
    const queued = limiter.submit(
      () => {
        ran = true;
      },
      { cost: 1, signal: controller.signal },
    );
    const rejected = expect(queued).rejects.toMatchObject({ code: 'ABORTED' });
    controller.abort();
    try {
      await rejected;
      await first;
      expect(ran).toBe(false);
    } finally {
      await limiter.close();
    }
  });
  it('Bottleneck L4 starts with B and periodically refills integral capacity', async () => {
    const cell = cellFor('L4');
    cell.rules = [{ limit: 1, intervalMs: 250, burst: 3 }];
    const limiter = await adapterFor('bottleneck').create(context(cell));
    const starts: number[] = [];
    try {
      await Promise.all(
        Array.from({ length: 5 }, () =>
          limiter.submit(
            () => {
              starts.push(performance.now());
            },
            { cost: 1 },
          ),
        ),
      );
      expect(starts[2]! - starts[0]!).toBeLessThan(200);
      expect(starts[3]! - starts[0]!).toBeGreaterThanOrEqual(220);
      expect(starts[4]! - starts[3]!).toBeGreaterThanOrEqual(230);
    } finally {
      await limiter.close();
    }
  });
  it('Bottleneck maps integral cost to reservoir units only without concurrency', async () => {
    const cell = cellFor('L3');
    cell.rules = [{ limit: 3, intervalMs: 500, algorithm: 'fixed-window' }];
    cell.workload.job.costs = { values: [2], weights: [1] };
    expect(adapterFor('bottleneck').supports(cell)).toBe(true);
    expect(
      adapterFor('bottleneck').supports({ ...cell, concurrency: 3 }),
    ).not.toBe(true);
    expect(adapterFor('p-queue').supports(cell)).not.toBe(true);
    const limiter = await adapterFor('bottleneck').create(context(cell));
    const starts: number[] = [];
    try {
      await Promise.all(
        Array.from({ length: 3 }, () =>
          limiter.submit(
            () => {
              starts.push(performance.now());
            },
            { cost: 2 },
          ),
        ),
      );
      expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(480);
      expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(480);
    } finally {
      await limiter.close();
    }
  });
  it('identity invokes callbacks directly and has no admission claim', async () => {
    const limiter = await adapterFor('identity').create(context(cellFor('D1')));
    let called = false;
    const pending = limiter.submit(
      () => {
        called = true;
        return 42;
      },
      { cost: 1 },
    );
    expect(called).toBe(true);
    expect(await pending).toBe(42);
    await limiter.close();
  });
  it('matrix matches supports; V-only excludes the separately reported identity floor', () => {
    const matrix = naMatrix();
    for (const category of CATEGORIES)
      for (const adapter of competitorAdapters) {
        const support = adapter.supports(
          category.buildCell({ library: adapter.id }),
        );
        const status = matrix[category.id]![adapter.id]!;
        if (category.id === 'V-only') expect(status).toHaveProperty('na');
        else if (support === true)
          expect(status === 'supported' || 'approximate' in status).toBe(true);
        else expect(status).toEqual({ na: support });
      }
    expect(matrix.L4!.bottleneck).toHaveProperty('approximate');
    expect(matrix.L5!['p-queue']).toBe('supported');
  });
  it('rejects semantic mismatches', () => {
    for (const adapter of competitorAdapters.filter(
      (a) => a.id !== 'identity',
    )) {
      for (const patch of [
        {
          workload: { ...cellFor('L1').workload, deadlines: { maxWaitMs: 5 } },
        },
        { rules: [{ limit: 2, intervalMs: 100, scope: 'tenant' }] },
        { category: 'V-only' },
      ])
        expect(adapter.supports({ ...cellFor('L1'), ...patch })).not.toBe(true);
    }
    expect(adapterFor('p-limit').supports(cellFor('L2'))).not.toBe(true);
    expect(adapterFor('p-queue').supports(cellFor('L4'))).not.toBe(true);
  });
  it('Bottleneck priority mapping is monotonic, bounded, default 5, and explicit about saturation', () => {
    expect(bottleneckPriority()).toBe(5);
    for (let p = -100; p < 100; p++) {
      expect(bottleneckPriority(p + 1)).toBeLessThanOrEqual(
        bottleneckPriority(p),
      );
      expect(bottleneckPriority(p)).toBeGreaterThanOrEqual(0);
      expect(bottleneckPriority(p)).toBeLessThanOrEqual(9);
    }
  });
});
