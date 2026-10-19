// Harness-owned Redis/Valkey containers. Only containers labelled `dev.valve.perf=1` and
// recorded in .perf/infra.json are ever flushed, restarted, paused or shaped.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Redis } from 'ioredis';
import { decode, encode } from '../core/codec.ts';
import { ensureDir, infraFile, stateDir } from '../core/paths.ts';

export const LABEL = 'dev.valve.perf';
export const SENTINEL_KEY = '__valve_perf_disposable__';

export interface ServerDef {
  image: string;
  binary: 'redis-server' | 'valkey-server';
  cli: 'redis-cli' | 'valkey-cli';
  port: number;
}
/** Catalog of supported servers. `-netem` variants use locally built images with iproute2. */
export const CATALOG: Record<string, ServerDef> = {
  redis62: {
    image: 'redis:6.2',
    binary: 'redis-server',
    cli: 'redis-cli',
    port: 16462,
  },
  redis74: {
    image: 'redis:7.4',
    binary: 'redis-server',
    cli: 'redis-cli',
    port: 16479,
  },
  redis8: {
    image: 'redis:8',
    binary: 'redis-server',
    cli: 'redis-cli',
    port: 16481,
  },
  valkey72: {
    image: 'valkey/valkey:7.2',
    binary: 'valkey-server',
    cli: 'valkey-cli',
    port: 16472,
  },
  valkey8: {
    image: 'valkey/valkey:8',
    binary: 'valkey-server',
    cli: 'valkey-cli',
    port: 16480,
  },
};

export interface ServerState {
  container: string | null;
  image: string;
  /** Direct container address (Linux), bypassing docker-proxy. */
  url: string;
  /** Published loopback address (portable fallback). */
  hostUrl: string;
  token: string;
  createdAt: string;
  cpuset: string | null;
  netem: boolean;
  adopted?: boolean;
}
export interface InfraState {
  version: 1;
  servers: Record<string, ServerState>;
}

const docker = (args: string[], opts: { quiet?: boolean } = {}) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', opts.quiet ? 'ignore' : 'pipe'],
  }).trim();

export function readInfra(): InfraState {
  if (!existsSync(infraFile)) return { version: 1, servers: {} };
  return decode<InfraState>(readFileSync(infraFile, 'utf8'));
}
function writeInfra(state: InfraState) {
  ensureDir(stateDir);
  writeFileSync(infraFile, encode(state, 2));
}

const baseName = (name: string) => name.replace(/-netem$/, '');
export const netemImage = (name: string) =>
  `valve-perf/${baseName(name)}-netem`;

/** Choose the URL to use: direct container IP on Linux, loopback elsewhere or on request. */
export function serverUrl(s: ServerState): string {
  if (process.env.VALVE_PERF_HOST_PORTS === '1' || process.platform !== 'linux')
    return s.hostUrl;
  return s.url;
}

async function waitReady(url: string) {
  const deadline = Date.now() + 20000;
  for (;;) {
    const c = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    try {
      await c.connect();
      await c.ping();
      c.disconnect();
      return;
    } catch {
      c.disconnect();
      if (Date.now() > deadline) throw new Error(`server at ${url} not ready`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

/** Write the sentinel that marks this endpoint disposable for the harness. */
export async function writeSentinel(url: string, token: string) {
  const c = new Redis(url);
  try {
    await c.set(SENTINEL_KEY, token);
  } finally {
    c.disconnect();
  }
}

/** Start (or reuse) a harness-owned server container. */
export async function up(
  name: string,
  options: { cpuset?: string; recreate?: boolean } = {},
): Promise<ServerState> {
  const netem = name.endsWith('-netem');
  const def = CATALOG[baseName(name)];
  if (!def)
    throw new Error(
      `unknown server ${name}; known: ${Object.keys(CATALOG).join(', ')}`,
    );
  const state = readInfra();
  const container = `valve-perf-${name}`;
  const exists = docker(
    ['ps', '-a', '--filter', `name=^${container}$`, '--format', '{{.Names}}'],
    { quiet: true },
  );
  if (
    exists &&
    docker([
      'inspect',
      '-f',
      `{{index .Config.Labels "${LABEL}"}}`,
      container,
    ]) !== '1'
  )
    throw new Error(
      `${container} is not harness-owned; refusing to start or recreate it`,
    );
  if (exists && options.recreate) docker(['rm', '-f', container]);
  if (!exists || options.recreate) {
    const port = def.port + (netem ? 1000 : 0);
    const image = netem ? netemImage(name) : def.image;
    docker([
      'run',
      '-d',
      '--name',
      container,
      '--label',
      `${LABEL}=1`,
      '--label',
      `${LABEL}.server=${name}`,
      ...(options.cpuset ? ['--cpuset-cpus', options.cpuset] : []),
      ...(netem ? ['--cap-add', 'NET_ADMIN'] : []),
      '-p',
      `127.0.0.1:${port}:6379`,
      image,
      def.binary,
      '--save',
      '',
      '--appendonly',
      'no',
    ]);
  } else docker(['start', container], { quiet: true });
  const labels = docker([
    'inspect',
    '-f',
    `{{index .Config.Labels "${LABEL}"}}`,
    container,
  ]);
  if (labels !== '1')
    throw new Error(
      `${container} exists but is not harness-owned (missing label ${LABEL}=1); refusing to use it.`,
    );
  const ip = docker([
    'inspect',
    '-f',
    '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
    container,
  ]);
  const hostPort = docker(['port', container, '6379/tcp'])
    .split('\n')[0]!
    .split(':')
    .at(-1);
  const prev = state.servers[name];
  const s: ServerState = {
    container,
    image: docker(['inspect', '-f', '{{.Config.Image}}', container]),
    url: `redis://${ip}:6379`,
    hostUrl: `redis://127.0.0.1:${hostPort}`,
    token: prev?.token ?? randomUUID(),
    createdAt: prev?.createdAt ?? new Date().toISOString(),
    cpuset:
      docker(['inspect', '-f', '{{.HostConfig.CpusetCpus}}', container]) ||
      null,
    netem,
  };
  await waitReady(serverUrl(s));
  await writeSentinel(serverUrl(s), s.token);
  state.servers[name] = s;
  writeInfra(state);
  return s;
}

/** Stop and remove a harness-owned container (label checked). */
export function down(name: string) {
  const state = readInfra();
  const s = state.servers[name];
  if (s?.container) {
    const label = docker(
      ['inspect', '-f', `{{index .Config.Labels "${LABEL}"}}`, s.container],
      { quiet: true },
    );
    if (label !== '1')
      throw new Error(`${s.container} is not harness-owned; not removing.`);
    docker(['rm', '-f', s.container]);
  }
  delete state.servers[name];
  writeInfra(state);
}

/**
 * Adopt an external endpoint as disposable. Only allowed when it is completely empty
 * (DBSIZE 0), so adopting can never destroy existing data.
 */
export async function adopt(name: string, url: string): Promise<ServerState> {
  const c = new Redis(url);
  try {
    const size = await c.dbsize();
    if (size !== 0)
      throw new Error(
        `Refusing to adopt ${url}: DBSIZE is ${size}, not 0. Only empty dedicated endpoints can be adopted.`,
      );
    const info = await c.info('server');
    const version =
      /(?:redis|valkey)_version:(\S+)/.exec(info)?.[1] ?? 'unknown';
    const s: ServerState = {
      container: null,
      image: `external:${version}`,
      url,
      hostUrl: url,
      token: randomUUID(),
      createdAt: new Date().toISOString(),
      cpuset: null,
      netem: false,
      adopted: true,
    };
    await c.set(SENTINEL_KEY, s.token);
    const state = readInfra();
    state.servers[name] = s;
    writeInfra(state);
    return s;
  } finally {
    c.disconnect();
  }
}

/** Status of recorded servers: reachable, sentinel intact, container running. */
export async function status(): Promise<
  Record<
    string,
    {
      url: string;
      reachable: boolean;
      sentinel: boolean;
      container: string | null;
    }
  >
> {
  const out: Record<
    string,
    {
      url: string;
      reachable: boolean;
      sentinel: boolean;
      container: string | null;
    }
  > = {};
  for (const [name, s] of Object.entries(readInfra().servers)) {
    const url = serverUrl(s);
    const c = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
      connectTimeout: 1500,
    });
    let reachable = false;
    let sentinel = false;
    try {
      await c.connect();
      reachable = true;
      sentinel = (await c.get(SENTINEL_KEY)) === s.token;
    } catch {
      // unreachable
    } finally {
      c.disconnect();
    }
    out[name] = { url, reachable, sentinel, container: s.container };
  }
  return out;
}

/** Image id of a server for the fingerprint. */
export function imageId(s: ServerState): string {
  if (!s.container) return s.image;
  try {
    return docker(['inspect', '-f', '{{.Image}}', s.container], {
      quiet: true,
    });
  } catch {
    return s.image;
  }
}
