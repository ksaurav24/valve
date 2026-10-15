// UC5: stop accepting work, reject queued calls, and drain a running call.
import assert from 'node:assert/strict';
import { createValve, isValveError } from 'valvejs';
const api = createValve({ id: 'service', concurrency: 1 });
let started!: () => void;
const ready = new Promise<void>((resolve) => {
  started = resolve;
});
const running = api.run(() => {
  started();
  return new Promise((resolve) => setTimeout(() => resolve('done'), 20));
});
await ready;
const waiting = api
  .run(() => 'queued')
  .catch((error) => {
    assert.ok(isValveError(error, 'CLOSED'));
    return 'closed';
  });
await api.close();
assert.equal(await running, 'done');
assert.equal(await waiting, 'closed');
console.log('Queued work rejected and running work drained.');
