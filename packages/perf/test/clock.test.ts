import { afterEach, describe, expect, it, vi } from 'vitest';
import { measureOffset } from '../src/core/clock.ts';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

/**
 * Fake host: wall = monotonic + trueOffset, each read advances 1 µs. `stallMs` preempts the
 * process just before the first Date.now() read that crosses a millisecond edge.
 */
function host(trueOffset: number, stallMs = 0) {
  let mono = 1000.3;
  let lastDate: number | undefined;
  let stalled = false;
  return {
    perfNow: () => (mono += 0.001),
    dateNow: () => {
      mono += 0.001;
      if (
        !stalled &&
        stallMs &&
        lastDate !== undefined &&
        Math.floor(mono + trueOffset) !== lastDate
      ) {
        stalled = true;
        mono += stallMs;
      }
      return (lastDate = Math.floor(mono + trueOffset));
    },
    timeOrigin: 0,
  };
}

describe('cross-process epoch clock', () => {
  it('recovers the wall-clock offset at a Date.now() edge', () => {
    const { offsetMs, bracketMs } = measureOffset(host(5_000_000.42));
    expect(Math.abs(offsetMs - 5_000_000.42)).toBeLessThan(0.01);
    expect(bracketMs).toBeLessThan(0.02);
  });

  it('discards a sample preempted inside its bracket', () => {
    const naive = measureOffset(host(7_000_000.25, 12), 1);
    expect(Math.abs(naive.offsetMs - 7_000_000.25)).toBeGreaterThan(5);
    const { offsetMs, bracketMs } = measureOffset(host(7_000_000.25, 12));
    expect(Math.abs(offsetMs - 7_000_000.25)).toBeLessThan(0.01);
    expect(bracketMs).toBeLessThan(0.02);
  });

  it('bounds calibration when Date.now is frozen even if the monotonic clock advances', () => {
    let reads = 0;
    let mono = 25;
    const result = measureOffset({
      dateNow: () => {
        reads++;
        return 1000;
      },
      perfNow: () => ++mono,
      timeOrigin: 10,
    });
    expect(reads).toBeLessThanOrEqual(100_002);
    expect(result.bracketMs).toBe(Infinity);
    expect(result.offsetMs).toBe(1000 - (10 + mono - 0.5));
  });

  it('can load with both clocks frozen and reports the fallback epoch', async () => {
    vi.resetModules();
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    vi.stubGlobal('performance', { timeOrigin: 10, now: () => 25 });
    const { epochNow } = await import('../src/core/clock.ts');
    expect(epochNow()).toBe(1000);
  });

  it('uses its calibrated monotonic clock without another wall-clock read', async () => {
    vi.resetModules();
    const readers = host(5_000_000.42);
    const date = vi.spyOn(Date, 'now').mockImplementation(readers.dateNow);
    const perf = vi.fn(readers.perfNow);
    vi.stubGlobal('performance', { timeOrigin: 0, now: perf });
    const { epochNow } = await import('../src/core/clock.ts');
    date.mockClear().mockImplementation(() => {
      throw new Error('wall clock must not be read after calibration');
    });
    perf.mockReturnValue(2000.5);
    expect(Math.abs(epochNow() - 5_002_000.92)).toBeLessThan(0.01);
    perf.mockReturnValue(2100.5);
    expect(Math.abs(epochNow() - 5_002_100.92)).toBeLessThan(0.01);
    expect(date).not.toHaveBeenCalled();
  });
});
