// Exercise the shipped ESM and CJS entries using only the target Node runtime.
const assert = require('node:assert/strict');
const { createValve } = require('../packages/valve/dist/index.cjs');
(async () => {
  const api = createValve({ id: 'smoke', concurrency: 1 });
  assert.equal(await api.run(() => 42), 42);
  await api.close();
  const esm = await import('../packages/valve/dist/index.js');
  const headers = await import('../packages/valve/dist/headers/index.js');
  const redis = require('../packages/valve/dist/redis/index.cjs');
  assert.equal(typeof esm.createValve, 'function');
  assert.equal(typeof redis.redisStore, 'function');
  assert.deepEqual(
    headers.retryAfter()({ status: 429, headers: { 'retry-after': '1' } }),
    { pauseMs: 1000 },
  );
  console.log('ESM, CJS, and subpath runtime smoke passed.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
