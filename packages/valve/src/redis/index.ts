// Shared Redis and Valkey budgets with script-cache recovery and timeouts.
import { duration } from '../duration.js';
import { invalid } from '../errors.js';
import type { AcquireRequest, Store } from '../store.js';
import { adapterFor } from './clients.js';
import {
  ACQUIRE,
  ACQUIRE_SHA,
  PAUSE,
  PAUSE_SHA,
  RESUME,
  RESUME_SHA,
} from './scripts.js';
import type { RedisStoreOptions } from './types.js';
export type {
  IoredisLike,
  NodeRedisLike,
  RedisEvalAdapter,
  RedisStoreOptions,
} from './types.js';
/** Create a store backed by a user-owned Redis or Valkey client.
 * @param options Exactly one client or adapter, plus prefix and timeout.
 * @returns An atomic shared budget store that never disconnects your client.
 * @throws {ValveError} INVALID_OPTIONS for an unsupported client, prefix, or timeout.
 * @example const store = redisStore({ client: redis }); const api = createValve({ id: 'shared', rate: { limit: 10, interval: '1s' }, store });
 */
export function redisStore(options: RedisStoreOptions): Store {
  const adapter = adapterFor(options);
  const prefix = options.prefix ?? 'valve';
  if (typeof prefix !== 'string' || /[{}]/.test(prefix))
    invalid(
      undefined,
      'redis prefix must be a string without braces',
      prefix,
      'Use a prefix without Redis hash tags',
    );
  const timeout = duration(options.timeout ?? '2s', undefined, 'redis timeout');
  const prepared = new WeakMap<AcquireRequest['rules'], string[]>();
  async function execute(
    script: string,
    sha: string,
    keys: string[],
    args: string[],
  ): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = Promise.resolve()
      .then(() => adapter.evalsha(sha, keys, args))
      .catch((error) => {
        if (error instanceof Error && error.message.includes('NOSCRIPT'))
          return adapter.eval(script, keys, args);
        throw error;
      });
    const limit = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(`valve: redis store call exceeded timeout ${timeout}ms.`),
          ),
        Math.min(2147483647, timeout),
      );
    });
    try {
      return await Promise.race([attempt, limit]);
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    kind: 'redis',
    acquire: async (request) => {
      let ruleArgs = prepared.get(request.rules);
      if (!ruleArgs) {
        ruleArgs = request.rules.flatMap((rule) => [
          rule.algorithm === 'gcra' ? '0' : '1',
          String(rule.intervalMs),
          String(rule.limit),
          String(rule.burst),
        ]);
        prepared.set(request.rules, ruleArgs);
      }
      const base = `${prefix}:{${request.id}}`;
      const keys = [
        `${base}:pause`,
        ...request.rules.map((rule) => `${base}:r:${rule.key}`),
      ];
      const args = [
        ...ruleArgs,
        String(request.costs.length),
        ...request.costs.map(String),
      ];
      const raw = await execute(ACQUIRE, ACQUIRE_SHA, keys, args);
      if (
        !Array.isArray(raw) ||
        raw.length !== 3 ||
        raw.some(
          (value) => !Number.isSafeInteger(Number(value)) || Number(value) < 0,
        )
      )
        throw new Error('valve: redis returned an invalid acquire result.');
      return {
        granted: Number(raw[0]),
        retryAfterMs: Number(raw[1]),
        pausedMs: Number(raw[2]),
      };
    },
    pause: async (id, ms) => {
      await execute(
        PAUSE,
        PAUSE_SHA,
        [`${prefix}:{${id}}:pause`],
        [String(ms)],
      );
    },
    resume: async (id) => {
      await execute(RESUME, RESUME_SHA, [`${prefix}:{${id}}:pause`], []);
    },
    close: () => Promise.resolve(),
  };
}
