// Property tests proving each rate bound across randomized weighted arrivals.
import { expect, it } from 'vitest';
import fc from 'fast-check';
import { memoryStore } from '../src/index.js';
import { normalize } from '../src/rules.js';
const arrival = fc.array(
  fc.record({
    gap: fc.integer({ min: 0, max: 200 }),
    cost: fc.integer({ min: 1, max: 8 }),
  }),
  { minLength: 1, maxLength: 80 },
);
it('GCRA obeys limit + burst - 1 in every half-open interval', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 20 }),
      fc.integer({ min: 1, max: 1000 }),
      fc.integer({ min: 1, max: 10 }),
      arrival,
      (limit, interval, burst, arrivals) => {
        let now = 0;
        const store = memoryStore({ clock: () => now });
        const rules = normalize({
          id: 'property',
          rate: { limit, interval, burst },
        }).rules;
        const starts: { time: number; cost: number }[] = [];
        for (const item of arrivals) {
          now += item.gap;
          const cost = Math.min(item.cost, burst);
          if (
            store.acquireSync!({ id: 'property', rules, costs: [cost] }).granted
          )
            starts.push({ time: now, cost });
        }
        for (const start of starts)
          expect(
            starts
              .filter(
                (s) => s.time >= start.time && s.time < start.time + interval,
              )
              .reduce((sum, s) => sum + s.cost, 0),
          ).toBeLessThanOrEqual(limit + burst - 1);
      },
    ),
    { numRuns: 400, seed: 12345 },
  );
});
it('fixed windows and several simultaneous rules obey every bound', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 20 }),
      fc.integer({ min: 1, max: 1000 }),
      arrival,
      (limit, interval, arrivals) => {
        let now = 0;
        const store = memoryStore({ clock: () => now });
        const rules = normalize({
          id: 'property',
          rate: [
            { limit, interval, algorithm: 'fixed-window' },
            { limit, interval: interval * 2, burst: 8 },
          ],
        }).rules;
        const starts: { time: number; cost: number }[] = [];
        const windows = new Map<number, number>();
        for (const item of arrivals) {
          now += item.gap;
          const cost = Math.min(item.cost, limit, 8);
          if (
            store.acquireSync!({ id: 'property', rules, costs: [cost] }).granted
          ) {
            const w = Math.floor(now / interval);
            windows.set(w, (windows.get(w) ?? 0) + cost);
            starts.push({ time: now, cost });
          }
        }
        for (const count of windows.values())
          expect(count).toBeLessThanOrEqual(limit);
        for (const start of starts)
          expect(
            starts
              .filter(
                (s) =>
                  s.time >= start.time && s.time < start.time + interval * 2,
              )
              .reduce((sum, s) => sum + s.cost, 0),
          ).toBeLessThanOrEqual(limit + 7);
      },
    ),
    { numRuns: 400, seed: 54321 },
  );
});
it('never grants while a randomized shared pause is active', async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 1, max: 100000 }), async (pause) => {
      let now = 0;
      const store = memoryStore({ clock: () => now });
      const rules = normalize({
        id: 'p',
        rate: { limit: 10, interval: 1, burst: 10 },
      }).rules;
      await store.pause('p', pause);
      now = pause - 1;
      expect(
        (await store.acquire({ id: 'p', rules, costs: [1] })).granted,
      ).toBe(0);
      now = pause;
      expect(
        (await store.acquire({ id: 'p', rules, costs: [1] })).granted,
      ).toBe(1);
    }),
    { numRuns: 100 },
  );
});
