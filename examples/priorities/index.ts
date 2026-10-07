// UC4: interactive work starts before background sync in a local queue.
import assert from 'node:assert/strict';
import { createValve } from '@ksaurav24/valve';
const api = createValve({ id: 'priority', concurrency: 1 });
const starts: string[] = [];
await Promise.all([
  api.run(() => starts.push('background')),
  api.run(() => starts.push('interactive'), { priority: 10 }),
  api.run(() => starts.push('background-2')),
]);
assert.deepEqual(starts, ['interactive', 'background', 'background-2']);
await api.close();
console.log(starts);
