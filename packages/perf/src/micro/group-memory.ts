/**
 * Lightweight memory and resource smoke for valvejs/group, outside tinybench.
 *
 * Run after `pnpm --filter valvejs build`:
 *   cd packages/perf && node --expose-gc --import tsx src/micro/group-memory.ts
 * Reports retained heap per resident key valve versus plain createValve, and
 * checks that high-cardinality churn stays within maxSize and leaves no ref'd
 * timers (the group's own sweep timer is unref'd, so it is not counted).
 */
import { createValve } from '../../../valve/dist/index.js';
import { createValveGroup } from '../../../valve/dist/group/index.js';

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error('Run with node --expose-gc');
const heap = () => {
  for (let i = 0; i < 3; i++) gc();
  return process.memoryUsage().heapUsed;
};
const timers = () =>
  process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
const noop = () => undefined;
const keys = 2_000;
const options = { concurrency: 4, feedback: false } as const;

const baseHeap = heap();
const plain = Array.from({ length: keys }, (_, i) =>
  createValve({ ...options, id: `plain:k${i}` }),
);
for (const valve of plain) await valve.run(noop);
const plainBytes = (heap() - baseHeap) / keys;
await Promise.all(plain.map((valve) => valve.close()));
plain.length = 0;

const groupBase = heap();
const resident = createValveGroup({
  id: 'resident',
  maxSize: keys,
  resolve: () => options,
});
for (let i = 0; i < keys; i++) await resident.run(`k${i}`, noop);
const groupBytes = (heap() - groupBase) / keys;
const residentTimers = timers();
await resident.close();

const churnBase = heap();
const churn = createValveGroup({
  id: 'churn',
  maxSize: 64,
  idleTtl: '1h',
  resolve: () => options,
});
const started = performance.now();
let peak = 0;
for (let i = 0; i < 50_000; i++) {
  await churn.run(`k${i}`, noop);
  peak = Math.max(peak, churn.stats().size);
}
const churnMs = performance.now() - started;
const churnHeap = heap() - churnBase;
const churnTimers = timers();
await churn.close();

const result = {
  node: process.version,
  plainValveBytesPerKey: Math.round(plainBytes),
  groupValveBytesPerKey: Math.round(groupBytes),
  residentKeys: keys,
  residentTimers,
  churnKeys: 50_000,
  churnMaxSize: 64,
  churnPeakSize: peak,
  churnUsPerNewKey: Math.round((churnMs / 50_000) * 1000 * 10) / 10,
  churnRetainedHeapKiB: Math.round(churnHeap / 1024),
  churnTimers,
  timersAfterClose: timers(),
};
console.log(JSON.stringify(result, null, 2));
if (
  peak > 64 ||
  residentTimers > 0 ||
  churnTimers > 0 ||
  result.timersAfterClose > 0
)
  process.exitCode = 1;
