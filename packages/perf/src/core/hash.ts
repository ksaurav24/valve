// Content hashes and run identifiers.
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { stable } from './codec.ts';

export const sha256 = (data: string | Uint8Array) =>
  createHash('sha256').update(data).digest('hex');
export const sha1 = (data: string | Uint8Array) =>
  createHash('sha1').update(data).digest('hex');
export const fileSha256 = (path: string) => sha256(readFileSync(path));
/** Hash of a configuration object, independent of key order. */
export const objectHash = (value: unknown, length = 16) =>
  sha256(stable(value)).slice(0, length);

/** Sortable unique run id: `20261019T091500Z-<6 hex>`. */
export function runId(now = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  return `${stamp}-${randomBytes(3).toString('hex')}`;
}
