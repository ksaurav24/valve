// UC6: feed an axios-shaped response into valve without changing clients.
import assert from 'node:assert/strict';
import { createValve } from '@ksaurav24/valve';
const api = createValve({ id: 'axios:example', concurrency: 1 });
const response = await api.run(
  () => ({
    status: 429,
    headers: { 'retry-after': '0.01' },
    data: { message: 'slow down' },
  }),
  { observe: (result) => result },
);
assert.equal(response.data.message, 'slow down');
assert.ok(api.stats().pausedUntil !== null);
await api.close();
console.log('Client response mapped into shared feedback.');
