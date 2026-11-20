// Generated script digests must describe the exact source sent on NOSCRIPT.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as scripts from '../src/redis/scripts.js';

describe('generated Lua', () => {
  it.each([
    'ACQUIRE',
    'SCOPED',
    'PAUSE',
    'RESUME',
    'RELEASE',
    'RENEW',
    'MANAGED',
  ] as const)('%s has a digest of its shipped source', (name) => {
    expect(createHash('sha1').update(scripts[name]).digest('hex')).toBe(
      scripts[`${name}_SHA`],
    );
  });
});
