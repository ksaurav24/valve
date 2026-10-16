// Shared Redis and Valkey budgets with script-cache recovery and timeouts.
import { prepareScoped } from '../scoped.js';
import { duration } from '../duration.js';
import { failure, invalid } from '../errors.js';
import type { AcquireRequest, Store } from '../store.js';
import { subscriptions } from './subscriptions.js';
import { adapterFor } from './clients.js';
import {
  ACQUIRE,
  ACQUIRE_SHA,
  SCOPED,
  SCOPED_SHA,
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
  if (timeout < 1)
    invalid(
      undefined,
      'redis timeout must be at least 1ms',
      options.timeout,
      'Use a timeout of 1ms or more',
    );
  const prepared = new WeakMap<
    AcquireRequest['rules'],
    { args: string[]; fingerprint: string }
  >();
  /** Execute a Redis script with NOSCRIPT recovery and the configured timeout.
   * A timeout rejects the caller without cancelling an already-issued command.
   * @param script Lua source used when the server has not cached sha.
   * @param sha Script digest for the initial EVALSHA attempt.
   * @param keys Redis keys passed to the script.
   * @param args Serialized script arguments.
   * @returns The unvalidated Redis reply.
   */
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
    acquireScoped: async (request) => {
      const plan = prepareScoped(request);
      const base = `${prefix}:{${request.id}}`;
      const raw = await execute(
        SCOPED,
        SCOPED_SHA,
        [
          `${base}:config`,
          `${base}:pause`,
          `${base}:leases`,
          ...plan.keys.map((key) => `${base}:${key}`),
        ],
        [
          JSON.stringify({
            rules: plan.rules,
            jobs: plan.jobs,
            fingerprint: plan.fingerprint,
            ...(request.lease ? { lease: request.lease } : {}),
          }),
        ],
      );
      if (raw === 'CONFIG_MISMATCH')
        throw failure(
          request.id,
          'INVALID_OPTIONS',
          'Shared scoped quota configuration does not match Redis. Drain workers and follow the shared quota migration procedure.',
        );
      if (!Array.isArray(raw) || raw.length !== 3 || !raw.every(Array.isArray))
        throw new Error('valve: invalid scoped acquire result.');
      const [granted, blocked, tokens] = raw as [
        number[],
        [number, number][],
        [number, string][],
      ];
      return {
        grantedIndexes: granted,
        blocked: blocked.map(([index, retryAfterMs]) => ({
          index,
          retryAfterMs,
        })),
        ...(request.lease
          ? { leases: tokens.map(([index, token]) => ({ index, token })) }
          : {}),
      };
    },
    /** Check shared configuration and acquire rate budget and leases atomically.
     * @param request Normalized quota rules, job costs, and optional lease settings.
     * @returns Granted job count, retry timing, and any acquired lease tokens.
     * @throws {ValveError} INVALID_OPTIONS when Redis reports a configuration mismatch.
     */
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

/** Serialize normalized rules for Lua and a fingerprint that ignores rule order.
 * @param rules Normalized rules in admission script order.
 * @returns Lua arguments in request order and a canonical versioned fingerprint.
 */
function prepareRules(rules: AcquireRequest['rules']) {
  return {
    args: rules.flatMap((rule) => [
      rule.algorithm === 'gcra' ? '0' : '1',
      String(rule.intervalMs),
      String(rule.limit),
      String(rule.burst),
    ]),
    fingerprint: `${rules.some((rule) => rule.name) ? 'named-v1' : 'v1'}:[${rules
      .map((rule) =>
        JSON.stringify([
          rule.algorithm,
          rule.intervalMs,
          rule.limit,
          rule.burst,
          ...(rule.name ? [rule.name] : []),
        ]),
      )
      .sort()
      .join(',')}]`,
  };
}
