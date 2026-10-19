// Locally built netem-capable server images (base image + iproute2), required for RTT shaping.
import { execFileSync } from 'node:child_process';
import { CATALOG, netemImage } from './servers.ts';

export function hasImage(tag: string): boolean {
  try {
    execFileSync('docker', ['image', 'inspect', tag], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Build `valve-perf/<name>-netem` from the catalog image. Needs network access for apt. */
export function buildNetemImage(name: string): string {
  const def = CATALOG[name.replace(/-netem$/, '')];
  if (!def) throw new Error(`unknown server ${name}`);
  const tag = netemImage(name);
  if (hasImage(tag)) return tag;
  const dockerfile = `FROM ${def.image}\nUSER root\nRUN apt-get update && apt-get install -y --no-install-recommends iproute2 && rm -rf /var/lib/apt/lists/*\n`;
  execFileSync('docker', ['build', '-t', tag, '-'], {
    input: dockerfile,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  return tag;
}
