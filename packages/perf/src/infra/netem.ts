// RTT shaping with tc netem inside a harness-owned `-netem` container. The qdisc applies to the
// server's egress, so the whole added delay is on the reply direction (documented limitation).
import { execFileSync } from 'node:child_process';
import type { NetworkSpec } from '../core/types.ts';
import type { Endpoint } from './safety.ts';

function tc(container: string, args: string[]) {
  return execFileSync('docker', ['exec', container, 'tc', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function containerOf(endpoint: Endpoint): string {
  if (!endpoint.server?.container || !endpoint.server.netem)
    throw new Error(
      `RTT shaping needs a harness-owned -netem server (got ${endpoint.name}); run \`pnpm perf infra images && pnpm perf infra up redis74-netem\``,
    );
  return endpoint.server.container;
}

/** Replace the root qdisc with the requested delay/jitter/loss. A zero spec clears shaping. */
export function applyNetwork(
  endpoint: Endpoint,
  spec: NetworkSpec | undefined,
) {
  const c = containerOf(endpoint);
  try {
    tc(c, ['qdisc', 'del', 'dev', 'eth0', 'root']);
  } catch {
    // no qdisc yet
  }
  if (!spec || (!spec.delayMs && !spec.jitterMs && !spec.lossPct)) return;
  const args = [
    'qdisc',
    'add',
    'dev',
    'eth0',
    'root',
    'netem',
    'delay',
    `${spec.delayMs}ms`,
  ];
  if (spec.jitterMs)
    args.push(
      `${spec.jitterMs}ms`,
      'distribution',
      spec.distribution ?? 'normal',
    );
  if (spec.lossPct) args.push('loss', `${spec.lossPct}%`);
  tc(c, args);
}

export function clearNetwork(endpoint: Endpoint) {
  if (endpoint.server?.netem && endpoint.server.container)
    applyNetwork(endpoint, undefined);
}

/** Current qdisc description, for the trial record. */
export function describeNetwork(endpoint: Endpoint): string | null {
  if (!endpoint.server?.netem || !endpoint.server.container) return null;
  try {
    return tc(endpoint.server.container, [
      'qdisc',
      'show',
      'dev',
      'eth0',
    ]).trim();
  } catch {
    return null;
  }
}
