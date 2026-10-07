// Structural Redis clients and adapter configuration.
import type { Duration } from '../types.js';

/** The ioredis client shape valve uses. `Redis` and `Cluster` instances fit.
 * @example const client: IoredisLike = redis;
 */
export interface IoredisLike {
  evalsha(
    sha: string,
    numKeys: number,
    ...keysAndArgs: (string | number)[]
  ): Promise<unknown>;
  eval(
    script: string,
    numKeys: number,
    ...keysAndArgs: (string | number)[]
  ): Promise<unknown>;
}

/** The node-redis v4 and v5 client shape valve uses.
 * @example const client: NodeRedisLike = redis;
 */
export interface NodeRedisLike {
  evalSha(
    sha: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown>;
  eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown>;
}

/**
 * Bring your own client. Implement two calls and valve does the rest.
 * Errors whose message contains `NOSCRIPT` must be rethrown unchanged.
 * @example const adapter: RedisEvalAdapter = { evalsha: (sha, keys, args) => client.evalsha(sha, keys.length, ...keys, ...args), eval: (script, keys, args) => client.eval(script, keys.length, ...keys, ...args) };
 */
export interface RedisEvalAdapter {
  evalsha(
    sha: string,
    keys: readonly string[],
    args: readonly string[],
  ): Promise<unknown>;
  eval(
    script: string,
    keys: readonly string[],
    args: readonly string[],
  ): Promise<unknown>;
}

/** Dedicated node-redis subscription connection, already connected.
 * @example const subscriber: NodeRedisSubscriber = client.duplicate();
 */
export interface NodeRedisSubscriber {
  subscribe(
    channel: string,
    listener: (message: string | Uint8Array) => void,
  ): Promise<unknown>;
  unsubscribe(
    channel: string,
    listener: (message: string | Uint8Array) => void,
  ): Promise<unknown>;
}
/** Dedicated ioredis subscription connection, separate from command traffic.
 * @example const subscriber: IoredisSubscriber = redis.duplicate();
 */
export interface IoredisSubscriber {
  subscribe(channel: string): Promise<unknown>;
  unsubscribe(channel: string): Promise<unknown>;
  on(
    event: 'message',
    listener: (channel: string, message: string) => void,
  ): unknown;
  off(
    event: 'message',
    listener: (channel: string, message: string) => void,
  ): unknown;
}

/** Options for {@link redisStore}. Give exactly one of `client` or `adapter`.
 * @example const options: RedisStoreOptions = { client: redis, timeout: '2s' };
 */
export type RedisStoreOptions = {
  /** Key prefix. Default `"valve"`. Must not contain `{` or `}`. */
  prefix?: string;
  /** Optional dedicated connection for immediate shared pause/resume/release notifications. Never disconnected by valve. */
  subscriber?: NodeRedisSubscriber | IoredisSubscriber;
  /** Max time for one store call before it counts as a store error. Default `"2s"`. */
  timeout?: Duration;
} & (
  | { client: IoredisLike | NodeRedisLike; adapter?: never }
  | { adapter: RedisEvalAdapter; client?: never }
);
