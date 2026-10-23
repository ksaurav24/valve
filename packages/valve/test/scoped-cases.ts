import type { RateRule } from '../src/types.js';
import type {
  ScopedAcquireRequest,
  ScopedAcquireResult,
} from '../src/store.js';

export const job = (recipient: string, cost = 1) => ({
  cost,
  scopes: { recipient },
});
const midnight = Date.UTC(2050, 0, 2);
// Explicit expectations shared by both backends, independent of either algorithm implementation.
export const scopedCases: {
  name: string;
  rate: RateRule[];
  steps: {
    now: number;
    jobs: ScopedAcquireRequest['jobs'];
    expected: ScopedAcquireResult;
  }[];
}[] = [
  {
    name: 'UTC boundary resets both shared and scoped fixed windows',
    rate: [
      { limit: 3, interval: '24h', algorithm: 'fixed-window' },
      {
        name: 'daily',
        scope: 'recipient',
        limit: 2,
        interval: '24h',
        algorithm: 'fixed-window',
      },
    ],
    steps: [
      {
        now: midnight - 2,
        jobs: [job('A'), job('A'), job('A')],
        expected: {
          grantedIndexes: [0, 1],
          blocked: [{ index: 2, retryAfterMs: 2 }],
        },
      },
      {
        now: midnight - 1,
        jobs: [job('A'), job('B')],
        expected: {
          grantedIndexes: [1],
          blocked: [{ index: 0, retryAfterMs: 1 }],
        },
      },
      {
        now: midnight,
        jobs: [job('A'), job('A'), job('A')],
        expected: {
          grantedIndexes: [0, 1],
          blocked: [{ index: 2, retryAfterMs: 86400000 }],
        },
      },
    ],
  },
  {
    name: 'mixed algorithms and independent bursts spend atomically',
    rate: [
      { limit: 4, interval: '1s', burst: 4 },
      {
        name: 'pacing',
        scope: 'recipient',
        limit: 1,
        interval: '1s',
        burst: 2,
      },
      {
        name: 'daily',
        scope: 'recipient',
        limit: 4,
        interval: '24h',
        algorithm: 'fixed-window',
      },
    ],
    steps: [
      {
        now: midnight,
        jobs: [job('A', 2), job('A'), job('B', 2), job('C')],
        expected: {
          grantedIndexes: [0, 2],
          blocked: [
            { index: 1, retryAfterMs: 1000 },
            { index: 3, retryAfterMs: 250 },
          ],
        },
      },
      {
        now: midnight + 250,
        jobs: [job('C')],
        expected: { grantedIndexes: [0], blocked: [] },
      },
      {
        now: midnight + 500,
        jobs: [job('C')],
        expected: { grantedIndexes: [0], blocked: [] },
      },
      {
        now: midnight + 1000,
        jobs: [job('A'), job('A')],
        expected: {
          grantedIndexes: [0],
          blocked: [{ index: 1, retryAfterMs: 1000 }],
        },
      },
    ],
  },
];
