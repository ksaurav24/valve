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
  const esmRedis = await import('../packages/valve/dist/redis/index.js');
  for (const [create, makeStore] of [
    [esm.createValve, redis.redisStore],
    [createValve, esmRedis.redisStore],
  ]) {
    for (const onStoreError of ['wait', 'throw', 'open']) {
      const store = makeStore({
        adapter: {
          evalsha: async () => 'CONFIG_MISMATCH',
          eval: async () => 'CONFIG_MISMATCH',
        },
      });
      const mixed = create({
        id: 'mixed-format',
        concurrency: 1,
        store,
        onStoreError,
        maxWait: 1000,
      });
      let calls = 0;
      try {
        await assert.rejects(
          mixed.run(() => ++calls),
          (error) => error.code === 'INVALID_OPTIONS',
        );
        assert.equal(calls, 0);
      } finally {
        await mixed.close();
        await store.close();
      }
    }
  }
  const {
    createValveGroup,
  } = require('../packages/valve/dist/group/index.cjs');
  const esmGroup = await import('../packages/valve/dist/group/index.js');
  for (const create of [createValveGroup, esmGroup.createValveGroup]) {
    const group = create({ id: 'smoke', resolve: () => ({ concurrency: 1 }) });
    assert.equal(group.get('a:b').id, 'smoke:a%3Ab');
    assert.equal(await group.run('a:b', () => 7), 7);
    await group.close();
  }
  assert.deepEqual(
    headers.retryAfter()({ status: 429, headers: { 'retry-after': '1' } }),
    { pauseMs: 1000 },
  );
  console.log('ESM, CJS, and subpath runtime smoke passed.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
