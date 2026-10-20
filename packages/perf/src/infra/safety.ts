// Destructive-operation guard. FLUSHDB happens only through `flushDisposable`, which requires a
// harness-recorded server whose sentinel key matches the recorded token. Everything else is
// prefix-scoped: SCAN MATCH <prefix>* + UNLINK of keys the trial created.
import { Redis } from 'ioredis';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { ensureDir, stateDir } from '../core/paths.ts';
import { sha256 } from '../core/hash.ts';
import {
  readInfra,
  SENTINEL_KEY,
  serverUrl,
  type ServerState,
} from './servers.ts';

export interface Endpoint {
  /** Infra name, or `external` for a user-supplied URL. */
  name: string;
  url: string;
  /** Flush allowed (harness-owned or adopted-empty, sentinel verified at use). */
  disposable: boolean;
  /** Container control (faults, netem) available. */
  controllable: boolean;
  server?: ServerState;
}

/** All aliases of a recorded server share one lock, including loopback and direct IP. */
export function endpointLockPath(url: string): string {
  const server = Object.values(readInfra().servers).find(
    (s) => s.url === url || s.hostUrl === url,
  );
  return join(
    ensureDir(join(stateDir, 'locks')),
    `${sha256(server?.url ?? url).slice(0, 24)}.lock`,
  );
}

/** Resolve an infra server name, or treat a `redis://` URL as external (prefix mode only). */
export function resolveEndpoint(nameOrUrl: string): Endpoint {
  if (/^rediss?:\/\//.test(nameOrUrl))
    return {
      name: 'external',
      url: nameOrUrl,
      disposable: false,
      controllable: false,
    };
  const s = readInfra().servers[nameOrUrl];
  if (!s)
    throw new Error(
      `server ${nameOrUrl} is not set up; run \`pnpm perf infra up ${nameOrUrl}\``,
    );
  return {
    name: nameOrUrl,
    url: serverUrl(s),
    disposable: true,
    controllable: !!s.container,
    server: s,
  };
}

/** Throw unless the endpoint is disposable and its live sentinel matches the recorded token. */
export async function assertDisposable(
  client: Redis,
  endpoint: Endpoint,
): Promise<void> {
  if (!endpoint.disposable || !endpoint.server)
    throw new Error(
      `Refusing destructive operation on ${endpoint.url}: not a harness-owned disposable endpoint.`,
    );
  if (endpoint.server.container) {
    const label = execFileSync(
      'docker',
      [
        'inspect',
        '-f',
        '{{index .Config.Labels "dev.valve.perf"}}',
        endpoint.server.container,
      ],
      { encoding: 'utf8' },
    ).trim();
    if (label !== '1')
      throw new Error(
        'Refusing destructive operation: container ownership label missing',
      );
  }
  const live = await client.get(SENTINEL_KEY);
  if (live !== endpoint.server.token)
    throw new Error(
      `Refusing destructive operation on ${endpoint.url}: sentinel ${SENTINEL_KEY} is ${live === null ? 'missing' : 'different'}. ` +
        'The endpoint may have been replaced by a non-harness server. Re-run `pnpm perf infra up`.',
    );
}

/** FLUSHDB a verified disposable endpoint and restore its sentinel. */
export async function flushDisposable(
  client: Redis,
  endpoint: Endpoint,
): Promise<void> {
  await assertDisposable(client, endpoint);
  await client.flushdb();
  await client.set(SENTINEL_KEY, endpoint.server!.token);
}

/** Delete only keys under `prefix` (never the sentinel). Returns the number of keys removed. */
export async function cleanupPrefix(
  client: Redis,
  prefix: string,
): Promise<number> {
  if (prefix.length < 6 || /[*?[\]]/.test(prefix))
    throw new Error(`unsafe cleanup prefix: ${prefix}`);
  let cursor = '0';
  let removed = 0;
  do {
    const [next, keys] = await client.scan(
      cursor,
      'MATCH',
      `${prefix}*`,
      'COUNT',
      1000,
    );
    cursor = next;
    const own = keys.filter((k) => k !== SENTINEL_KEY);
    if (own.length) removed += await client.unlink(...own);
  } while (cursor !== '0');
  return removed;
}
