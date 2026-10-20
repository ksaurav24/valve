import { describe, expect, it } from 'vitest';
import { epochNow, measureOffset } from '../src/core/clock.ts';

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

  it('agrees with Date.now() in this process', () => {
    const drift = Date.now() - epochNow();
    expect(drift).toBeGreaterThan(-1.5);
    expect(drift).toBeLessThan(1.5);
  });
});
