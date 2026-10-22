// Shared Redis and Valkey budgets with script-cache recovery and timeouts.
import { prepareScoped } from '../scoped.js';
import { duration } from '../duration.js';
import { ruleFingerprint } from '../rules.js';
import { failure, invalid } from '../errors.js';
import type {
  AcquireRequest,
  LimitsSnapshot,
  ManagedContext,
  ManagedStore,
  Store,
} from '../store.js';
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
  MANAGED,
  MANAGED_SHA,
} from './scripts.js';
import { checkPatch, marker, pin } from '../managed.js';
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
  const structures = new WeakMap<
    ManagedContext['rules'],
    {
      args: string[];
      static: string[];
      lease: string;
      marker: string;
      pin: string;
    }
  >();
  /**
   * Run managed.lua with the shared key layout and structural arguments.
   * Statuses become typed errors; script failures fail closed as INVALID_OPTIONS,
   * while server availability errors stay store errors for onStoreError.
   */
  async function managed(
    op: 'a' | 's' | 'g' | 'u',
    context: ManagedContext,
    keys: string[],
    extra: string[],
  ): Promise<unknown> {
    const base = `${prefix}:{${context.id}}`;
    const lease = context.lease
      ? `${context.lease.limit}:${context.lease.ttlMs}`
      : '';
    let structure = structures.get(context.rules);
    if (!structure || structure.lease !== lease) {
      structure = {
        lease,
        marker: marker(context),
        pin: pin(context),
        args: [
          String(context.rules.length),
          ...context.rules.flatMap((rule) => [
            rule.name!,
            rule.algorithm,
            String(rule.intervalMs),
            String(rule.limit),
            String(rule.burst),
            rule.scope === undefined ? '0' : '1',
          ]),
        ],
        static: context.rules
          .filter((rule) => rule.scope === undefined)
          .map((rule) => `r:${rule.key}`),
      };
      structures.set(context.rules, structure);
    }
    let raw: unknown;
    try {
      raw = await execute(
        MANAGED,
        MANAGED_SHA,
        [
          `${base}:config`,
          `${base}:limits`,
          `${base}:pause`,
          `${base}:leases`,
          `${base}:events`,
          ...(op === 'g' || op === 'u'
            ? structure.static.map((key) => `${base}:${key}`)
            : keys.map((key) => `${base}:${key}`)),
        ],
        [
          op,
          structure.marker,
          structure.pin,
          context.known ?? '',
          ...structure.args,
          ...extra,
        ],
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        /user_script|script:/i.test(message) &&
        !/OOM|READONLY|LOADING|BUSY|MASTERDOWN|CLUSTERDOWN|TRYAGAIN|NOREPLICAS|NOSCRIPT/.test(
          message,
        )
      )
        throw failure(
          context.id,
          'INVALID_OPTIONS',
          'Managed limits script failed on this Redis data. Check for keys modified outside valve.',
          error,
        );
      throw error;
    }
    if (typeof raw === 'string' && raw.startsWith('!')) {
      const split = raw.indexOf(':');
      const code = raw.slice(1, split);
      throw failure(
        context.id,
        code === 'LIMITS_CONFLICT' ? 'LIMITS_CONFLICT' : 'INVALID_OPTIONS',
        raw.slice(split + 1),
      );
    }
    return raw;
  }
  /** Decode a flat snapshot reply, using the caller's structure for algorithms, intervals and scopes. */
  function decode(
    context: ManagedContext,
    raw: unknown,
    unchanged = false,
  ): LimitsSnapshot | undefined {
    if (unchanged && Array.isArray(raw) && raw.length === 0) return undefined;
    const bad = () =>
      failure(
        context.id,
        'INVALID_OPTIONS',
        'Redis returned invalid managed limits.',
      );
    if (
      !Array.isArray(raw) ||
      raw.length !== 2 + context.rules.length * 3 ||
      typeof raw[0] !== 'string' ||
      !/^\d+\.\d+$/.test(raw[0]) ||
      !Number.isSafeInteger(Number(raw[0].split('.')[0])) ||
      !Number.isSafeInteger(Number(raw[1])) ||
      Number(raw[1]) < 1 ||
      Number(raw[0].split('.')[1]) !== Number(raw[1])
    )
      throw bad();
    const rules: Record<string, LimitsSnapshot['rules'][string]> = {};
    context.rules.forEach((rule, i) => {
      const limit = Number(raw[3 + i * 3]);
      const burst = Number(raw[4 + i * 3]);
      if (
        raw[2 + i * 3] !== rule.name ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        !Number.isSafeInteger(burst) ||
        burst < 1
      )
        throw bad();
      rules[rule.name!] = Object.freeze({
        algorithm: rule.algorithm,
        intervalMs: rule.intervalMs,
        limit,
        burst,
        ...(rule.scope === undefined ? {} : { scope: rule.scope }),
      });
    });
    return Object.freeze({
      version: raw[0],
      revision: Number(raw[1]),
      rules: Object.freeze(rules),
    });
  }
  const capability: ManagedStore = {
    version: 1,
    /** Static prefix admission against the authoritative limits. */
    acquire: async (request) => {
      const raw = await managed(
        'a',
        request,
        request.rules.map((rule) => `r:${rule.key}`),
        [
          ...(request.lease
            ? [
                'leases',
                String(request.lease.limit),
                String(request.lease.ttlMs),
                request.lease.owner,
              ]
            : ['local']),
          String(request.costs.length),
          ...request.costs.map(String),
        ],
      );
      if (
        !Array.isArray(raw) ||
        raw.length !== 7 ||
        Number(raw[0]) > request.costs.length ||
        ![0, 1].includes(raw[4]) ||
        ![0, 1].includes(raw[5]) ||
        raw
          .slice(0, 3)
          .some(
            (value) =>
              !Number.isSafeInteger(Number(value)) || Number(value) < 0,
          ) ||
        !Array.isArray(raw[3]) ||
        (!request.lease && raw[3].length !== 0) ||
        (request.lease &&
          (raw[3].length !== Number(raw[0]) ||
            new Set(raw[3]).size !== raw[3].length ||
            raw[3].some(
              (token: unknown) => typeof token !== 'string' || !token.length,
            )))
      )
        throw failure(
          request.id,
          'INVALID_OPTIONS',
          'Redis returned an invalid managed acquire result.',
        );
      const limits = decode(request, raw[6], true);
      return {
        granted: Number(raw[0]),
        retryAfterMs: Number(raw[1]),
        pausedMs: Number(raw[2]),
        ...(request.lease
          ? {
              leases: raw[3] as string[],
              leaseBlocked: Number(raw[4]) === 1,
            }
          : {}),
        ...(Number(raw[5]) === 1 ? { impossible: true } : {}),
        ...(limits ? { limits } : {}),
      };
    },
    /** Scoped all-or-none admission against the authoritative limits. */
    acquireScoped: async (request) => {
      const plan = prepareScoped(request, true);
      const index = new Map(request.rules.map((rule, i) => [rule, i + 1]));
      const raw = await managed('s', request, plan.keys, [
        JSON.stringify({
          kr: plan.rules.map((rule) => index.get(rule)),
          jobs: plan.jobs,
          ...(request.lease ? { lease: request.lease } : {}),
        }),
      ]);
      if (
        !Array.isArray(raw) ||
        raw.length !== 5 ||
        !raw.slice(0, 3).every(Array.isArray) ||
        !Number.isSafeInteger(Number(raw[3])) ||
        Number(raw[3]) < 0
      )
        throw failure(
          request.id,
          'INVALID_OPTIONS',
          'Redis returned an invalid managed scoped result.',
        );
      const [granted, blocked, tokens, pausedMs] = raw as [
        number[],
        [number, number, number, number][],
        [number, string][],
        number,
      ];
      const seen = new Set<number>();
      const validIndex = (value: number) =>
        Number.isSafeInteger(value) &&
        value >= 0 &&
        value < request.jobs.length &&
        !seen.has(value) &&
        !!seen.add(value);
      if (
        !granted.every(validIndex) ||
        !blocked.every(
          (entry) =>
            Array.isArray(entry) &&
            entry.length === 4 &&
            validIndex(entry[0]) &&
            Number.isSafeInteger(entry[1]) &&
            entry[1] > 0 &&
            [0, 1].includes(entry[2]) &&
            [0, 1].includes(entry[3]),
        ) ||
        seen.size !== request.jobs.length ||
        tokens.length !== (request.lease ? granted.length : 0) ||
        !tokens.every(
          (entry) =>
            Array.isArray(entry) &&
            entry.length === 2 &&
            granted.includes(entry[0]) &&
            typeof entry[1] === 'string' &&
            entry[1].length > 0,
        ) ||
        new Set(tokens.map((entry) => entry[0])).size !== tokens.length ||
        new Set(tokens.map((entry) => entry[1])).size !== tokens.length
      )
        throw failure(
          request.id,
          'INVALID_OPTIONS',
          'Redis returned invalid managed scoped grants or lease tokens.',
        );
      const limits = decode(request, raw[4], true);
      return {
        ...(Number(pausedMs) ? { pausedMs: Number(pausedMs) } : {}),
        grantedIndexes: granted,
        blocked: blocked.map(
          ([index, retryAfterMs, leaseBlocked, impossible]) => ({
            index,
            retryAfterMs,
            ...(request.lease ? { leaseBlocked: leaseBlocked === 1 } : {}),
            ...(impossible === 1 ? { impossible: true } : {}),
          }),
        ),
        ...(request.lease
          ? { leases: tokens.map(([index, token]) => ({ index, token })) }
          : {}),
        ...(limits ? { limits } : {}),
      };
    },
    getLimits: async (context) =>
      decode(context, await managed('g', { ...context, known: '' }, [], []))!,
    updateLimits: async (request) => {
      const entries = (
        patch: Record<string, { limit?: number; burst?: number }>,
      ) =>
        checkPatch(request.id, request.rules, patch).map(([name, value]) => [
          name,
          value.limit ?? false,
          value.burst ?? false,
        ]);
      const body = JSON.stringify({
        p: entries(request.patch),
        x: request.expect === undefined ? [] : entries(request.expect),
      });
      return decode(
        request,
        await managed('u', { ...request, known: '' }, [], [body]),
      )!;
    },
  };
  return {
    kind: 'redis',
    managed: capability,
    /** Execute atomic scoped admission and decode grants, retry causes, leases and pauses. */
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
      if (
        !Array.isArray(raw) ||
        raw.length !== 4 ||
        !raw.slice(0, 3).every(Array.isArray) ||
        !Number.isSafeInteger(Number(raw[3])) ||
        Number(raw[3]) < 0
      )
        throw new Error('valve: invalid scoped acquire result.');
      const [granted, blocked, tokens, pausedMs] = raw as [
        number[],
        [number, number, number][],
        [number, string][],
        number,
      ];
      return {
        ...(Number(pausedMs) ? { pausedMs: Number(pausedMs) } : {}),
        grantedIndexes: granted,
        blocked: blocked.map(([index, retryAfterMs, leaseBlocked]) => ({
          index,
          retryAfterMs,
          ...(request.lease ? { leaseBlocked: leaseBlocked === 1 } : {}),
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
        raw.length < 3 ||
        raw.length > 5 ||
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
        ...(request.lease
          ? {
              leases: (raw[3] ?? []) as string[],
              leaseBlocked: Number(raw[4]) === 1,
            }
          : {}),
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
    fingerprint: ruleFingerprint(rules),
  };
}
