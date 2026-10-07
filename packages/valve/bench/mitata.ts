// Adaptive hot-path microbenchmarks for local profiling with mitata.
import { bench, run } from 'mitata';
import PQueue from 'p-queue';
import { createValve } from '../src/index.js';
bench('valve, 1000 queued no-op jobs', async () => {
  const api = createValve({ id: 'mitata', concurrency: 16 });
  await Promise.all(
    Array.from({ length: 1000 }, () => api.run(() => undefined)),
  );
  await api.close();
});
bench('p-queue, 1000 queued no-op jobs', async () => {
  const queue = new PQueue({ concurrency: 16 });
  await Promise.all(
    Array.from({ length: 1000 }, () => queue.add(() => undefined)),
  );
});
await run();
