// Recognize user-owned Redis clients without importing their packages.
import { ValveError } from '../errors.js';
import type { RedisEvalAdapter, RedisStoreOptions } from './types.js';
export function adapterFor(options: RedisStoreOptions): RedisEvalAdapter {
  const bad = () =>
    new ValveError(
      'INVALID_OPTIONS',
      'valve: redisStore could not recognize the client. Pass an ioredis or node-redis v4+ client, or an adapter with evalsha and eval.',
    );
  if (options.adapter && options.client) throw bad();
  if (options.adapter) {
    if (
      typeof options.adapter.evalsha !== 'function' ||
      typeof options.adapter.eval !== 'function'
    )
      throw bad();
    return options.adapter;
  }
  const client = options.client;
  if (!client || typeof client.eval !== 'function') throw bad();
  if ('evalSha' in client && typeof client.evalSha === 'function')
    return {
      evalsha: (sha, keys, args) =>
        client.evalSha(sha, { keys: [...keys], arguments: [...args] }),
      eval: (script, keys, args) =>
        client.eval(script, { keys: [...keys], arguments: [...args] }),
    };
  if ('evalsha' in client && typeof client.evalsha === 'function')
    return {
      evalsha: (sha, keys, args) =>
        client.evalsha(sha, keys.length, ...keys, ...args),
      eval: (script, keys, args) =>
        client.eval(script, keys.length, ...keys, ...args),
    };
  throw bad();
}
