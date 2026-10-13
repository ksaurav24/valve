// Reproduce finite streamed Request uploads and GC-sensitive buffer snapshots.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
if (!global.gc) throw new Error('Run with --expose-gc');
const library =
  process.env.VALVE_BENCH_LIBRARY ??
  new URL('../src/index.ts', import.meta.url).href;
const { createValve } = await import(library);
const native = process.env.VALVE_BENCH_NATIVE === '1';
const settleMs = Number(process.env.VALVE_BENCH_SETTLE_MS ?? 0);
if (!Number.isFinite(settleMs) || settleMs < 0)
  throw new Error('Use a finite nonnegative settle delay');
const uploads = [];
const server = createServer(async (req, res) => {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of req) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  uploads.push({ bytes, hash: hash.digest('hex') });
  res.writeHead(uploads.length === 1 ? 429 : 200, { 'Retry-After': '0.05' });
  res.end('provider body');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let pulls = 0;
let cancels = 0;
const request = new Request(`http://127.0.0.1:${server.address().port}`, {
  method: 'PUT',
  duplex: 'half',
  body: new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array(65536).fill(pulls++));
      if (pulls === 256) controller.close();
    },
    cancel() {
      cancels++;
    },
  }),
});
global.gc();
const initial = process.memoryUsage();
const snapshots = [];
const observed = async (...args) => {
  const response = await fetch(...args);
  if (settleMs > 0)
    await new Promise((resolve) => setTimeout(resolve, settleMs));
  global.gc();
  snapshots.push({
    status: response.status,
    pulls,
    cancels,
    bodyUsed: request.bodyUsed,
    arrayBuffersDelta:
      process.memoryUsage().arrayBuffers - initial.arrayBuffers,
  });
  return response;
};
const valve = createValve({ id: 'reproduction', concurrency: 1 });
try {
  const response = await (native
    ? observed(request)
    : valve.wrapFetch(observed, { retries: 2 })(request));
  await response.text();
  console.log(
    JSON.stringify(
      {
        node: process.version,
        library,
        native,
        settleMs,
        finalStatus: response.status,
        uploads,
        snapshots,
        retried: valve.stats().totals.retried,
      },
      null,
      2,
    ),
  );
} finally {
  await valve.close();
  await new Promise((resolve) => server.close(resolve));
}
