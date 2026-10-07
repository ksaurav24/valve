// Pure header-reader cost, separate from queue or network throughput.
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import {
  retryAfter,
  ietfRateLimit,
  xRateLimit,
  defaultFeedback,
} from '../src/headers/index.js';
const jobs = 1000000,
  repeats = 5;
const response = {
  status: 429,
  headers: {
    'retry-after': '2',
    ratelimit: '"default";r=0;t=2',
    'x-ratelimit-remaining': '0',
    'x-ratelimit-reset': '2',
  },
};
const rows = [];
for (const [name, reader] of [
  ['Retry-After', retryAfter()],
  ['IETF RateLimit', ietfRateLimit()],
  ['X-RateLimit', xRateLimit()],
  ['combined feedback', defaultFeedback],
] as const) {
  const elapsedMs = [];
  let checksum = 0;
  for (let round = -1; round < repeats; round++) {
    const n = round < 0 ? 10000 : jobs;
    const start = performance.now();
    for (let i = 0; i < n; i++) {
      const signal = reader(response);
      checksum += signal?.pauseMs ?? signal?.resetMs ?? 0;
    }
    if (round >= 0) elapsedMs.push(performance.now() - start);
  }
  const median = elapsedMs.slice().sort((a, b) => a - b)[2]!;
  const row = {
    name,
    jobs,
    elapsedMs,
    readsPerSecond: (jobs / median) * 1000,
    checksum,
  };
  rows.push(row);
  console.log(JSON.stringify(row));
}
writeFileSync(
  'bench/headers.json',
  JSON.stringify(
    { node: process.version, date: new Date().toISOString(), repeats, rows },
    null,
    2,
  ) + '\n',
);
