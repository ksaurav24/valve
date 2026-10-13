// Shared Redis and Valkey budgets with script-cache recovery and timeouts.
import { duration } from '../duration.js';
import { failure, invalid } from '../errors.js';
import type { AcquireRequest, Store } from '../store.js';
import { subscriptions } from './subscriptions.js';
import { adapterFor } from './clients.js';
import {
  ACQUIRE,
  ACQUIRE_SHA,
  PAUSE,
  PAUSE_SHA,
  RESUME,
  RESUME_SHA,
  RELEASE,
  RELEASE_SHA,
  RENEW,
  RENEW_SHA,
} from './scripts.js';
import type { RedisStoreOptions } from './types.js';
export type {
  IoredisLike,
  IoredisSubscriber,
  NodeRedisSubscriber,
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
  if (options.subscriber && (options.subscriber as unknown) === options.client)
    invalid(
      undefined,
      'subscriber must use a separate connection',
      options.subscriber,
      'Pass a duplicate subscription client',
    );
  const notices = options.subscriber
    ? subscriptions(options.subscriber, prefix)
    : undefined;
  const timeout = duration(options.timeout ?? '2s', undefined, 'redis timeout');
  const prepared = new WeakMap<
    AcquireRequest['rules'],
    { args: string[]; fingerprint: string }
  >();
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
      let rules = prepared.get(request.rules);
      if (!rules) {
        rules = prepareRules(request.rules);
        prepared.set(request.rules, rules);
      }
      const base = `${prefix}:{${request.id}}`;
      const keys = [
        `${base}:pause`,
        ...request.rules.map((rule) => `${base}:r:${rule.key}`),
        ...(request.lease ? [`${base}:leases`] : []),
        `${base}:config`,
      ];
      const args = [
        `${rules.fingerprint}:${request.lease ? `${request.lease.limit}:${request.lease.ttlMs}` : 'local'}`,
        ...(request.lease
          ? [
              'leases',
              String(request.lease.limit),
              String(request.lease.ttlMs),
              request.lease.owner,
            ]
          : []),
        ...rules.args,
        String(request.costs.length),
        ...request.costs.map(String),
      ];
      const raw = await execute(ACQUIRE, ACQUIRE_SHA, keys, args);
      if (raw === 'CONFIG_MISMATCH')
        throw failure(
          request.id,
          'INVALID_OPTIONS',
          'shared quota configuration does not match Redis. Use identical rate and global concurrency settings on every worker; drain all workers and follow the shared quota migration procedure before resetting the config key.',
        );
      if (
        !Array.isArray(raw) ||
        (raw.length !== 3 && raw.length !== 4) ||
        raw
          .slice(0, 3)
          .some(
            (value) =>
              !Number.isSafeInteger(Number(value)) || Number(value) < 0,
          )
      )
        throw new Error('valve: redis returned an invalid acquire result.');
      if (
        request.lease &&
        Number(raw[0]) > 0 &&
        (!Array.isArray(raw[3]) ||
          raw[3].length !== Number(raw[0]) ||
          raw[3].some((token: unknown) => typeof token !== 'string'))
      )
        throw new Error('valve: redis returned invalid lease tokens.');
      return {
        ...(request.lease ? { leases: (raw[3] ?? []) as string[] } : {}),
        granted: Number(raw[0]),
        retryAfterMs: Number(raw[1]),
        pausedMs: Number(raw[2]),
      };
    },
    pause: async (id, ms) => {
      await execute(
        PAUSE,
        PAUSE_SHA,
        [`${prefix}:{${id}}:pause`, `${prefix}:{${id}}:events`],
        [String(ms)],
      );
    },
    resume: async (id) => {
      await execute(
        RESUME,
        RESUME_SHA,
        [`${prefix}:{${id}}:pause`, `${prefix}:{${id}}:events`],
        [],
      );
    },
    release: async (id, leases) => {
      if (leases.length)
        await execute(
          RELEASE,
          RELEASE_SHA,
          [`${prefix}:{${id}}:leases`, `${prefix}:{${id}}:events`],
          [...leases],
        );
    },
    renew: async (id, leases, ttlMs) =>
      Number(
        await execute(
          RENEW,
          RENEW_SHA,
          [`${prefix}:{${id}}:leases`],
          [String(ttlMs), ...leases],
        ),
      ) === 1,
    ...(notices ? { subscribe: notices.subscribe } : {}),
    close: () => notices?.close() ?? Promise.resolve(),
  };
}

function prepareRules(rules: AcquireRequest['rules']) {
  return {
    args: rules.flatMap((rule) => [
      rule.algorithm === 'gcra' ? '0' : '1',
      String(rule.intervalMs),
      String(rule.limit),
      String(rule.burst),
    ]),
    // Canonical, collision-free encoding; rule order does not affect admission.
    fingerprint: `v1:[${rules
      .map((rule) =>
        JSON.stringify([
          rule.algorithm,
          rule.intervalMs,
          rule.limit,
          rule.burst,
        ]),
      )
      .sort()
      .join(',')}]`,
  };
}
