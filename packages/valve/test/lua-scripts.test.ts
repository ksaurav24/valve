// Generated script digests must describe the exact source sent on NOSCRIPT.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as scripts from '../src/redis/scripts.js';
import { withLuaClock } from './lua-clock.js';

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
  it.each(['ACQUIRE', 'SCOPED', 'RENEW', 'MANAGED'] as const)(
    '%s keeps the production clock in the minified parity harness',
    (name) => {
      const source = withLuaClock(scripts[name]);
      expect(source).not.toContain("redis.call('TIME')");
      expect(source).toContain('tonumber(ARGV[#ARGV])');
    },
  );
});
