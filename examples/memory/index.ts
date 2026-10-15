// UC2: space a single-process script without an external store.
import assert from 'node:assert/strict';
import { createValve } from 'valvejs';
const api = createValve({
  id: 'github:script',
  rate: { limit: 100, interval: '1s' },
});
const results = await Promise.all(
  [1, 2, 3].map((id) => api.run(() => ({ id }))),
);
assert.deepEqual(results, [{ id: 1 }, { id: 2 }, { id: 3 }]);
await api.close();
console.log('Three calls shared one memory budget.');
