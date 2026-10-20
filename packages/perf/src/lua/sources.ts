// Shipped Lua of a Valve build, read from that build's generated scripts.ts and
// verified against the SHA-1 digests the store uses for EVALSHA.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha1 } from '../core/hash.ts';

export const SCRIPT_NAMES = [
  'ACQUIRE',
  'SCOPED',
  'PAUSE',
  'RESUME',
  'RELEASE',
  'RENEW',
] as const;
export type ScriptName = (typeof SCRIPT_NAMES)[number];
export interface ScriptSource {
  name: ScriptName;
  source: string;
  sha: string;
}

/** Parse `export const NAME = "..."; export const NAME_SHA = '...'` pairs. */
export function parseScripts(text: string): Record<ScriptName, ScriptSource> {
  const out = {} as Record<ScriptName, ScriptSource>;
  for (const name of SCRIPT_NAMES) {
    const src = new RegExp(
      `export const ${name}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*")`,
    ).exec(text);
    const sha = new RegExp(
      `export const ${name}_SHA\\s*=\\s*'([0-9a-f]{40})'`,
    ).exec(text);
    if (!src?.[1] || !sha?.[1]) throw new Error(`scripts.ts: missing ${name}`);
    const source = JSON.parse(src[1]) as string;
    if (sha1(source) !== sha[1])
      throw new Error(`scripts.ts: ${name} digest does not match its source`);
    out[name] = { name, source, sha: sha[1] };
  }
  return out;
}

/** Load and verify the scripts of the valve package at `packageDir`. */
export function loadScripts(
  packageDir: string,
): Record<ScriptName, ScriptSource> {
  return parseScripts(
    readFileSync(join(packageDir, 'src/redis/scripts.ts'), 'utf8'),
  );
}
