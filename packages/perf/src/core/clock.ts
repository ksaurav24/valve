// Same-host epoch timebase shared by the supervisor and every worker process.
// performance.timeOrigin is captured once per process with an unbracketed wall-clock read, so a
// preemption at startup leaves that whole process several milliseconds off its peers. Anchor the
// monotonic clock to a Date.now() millisecond edge instead, keeping the tightest bracketed sample.

export interface ClockReaders {
  dateNow: () => number;
  perfNow: () => number;
  timeOrigin: number;
}

/**
 * Offset from `timeOrigin + perfNow()` to the wall clock, read at a Date.now() edge.
 * Each sample brackets the edge between two monotonic reads; the narrowest bracket wins, so a
 * preempted sample is discarded. Stops early once a bracket is within `goodMs`.
 */
export function measureOffset(
  readers: ClockReaders,
  maxSamples = 40,
  goodMs = 0.02,
): { offsetMs: number; bracketMs: number } {
  let bracketMs = Infinity;
  let offsetMs = 0;
  for (let i = 0; i < maxSamples && bracketMs > goodMs; i++) {
    const first = readers.dateNow();
    let before = readers.perfNow();
    let edge = readers.dateNow();
    while (edge === first) {
      before = readers.perfNow();
      edge = readers.dateNow();
    }
    const after = readers.perfNow();
    if (after - before < bracketMs) {
      bracketMs = after - before;
      offsetMs = edge - (readers.timeOrigin + (before + after) / 2);
    }
  }
  return { offsetMs, bracketMs };
}

const anchor = measureOffset({
  dateNow: Date.now,
  perfNow: () => performance.now(),
  timeOrigin: performance.timeOrigin,
});

/** Epoch milliseconds, comparable across harness processes on one host. */
export const epochNow = () =>
  performance.timeOrigin + performance.now() + anchor.offsetMs;
