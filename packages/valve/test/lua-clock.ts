// Test-only clock substitution; production scripts always use Redis TIME.
export function withLuaClock(source: string): string {
  const clock =
    "local t = redis.call('TIME')\nlocal now = tonumber(t[1]) * 1000 + tonumber(t[2]) / 1000";
  if (!source.includes(clock))
    throw new Error(
      'Production Lua clock changed; update the parity harness explicitly.',
    );
  return source.replace(clock, 'local now = tonumber(ARGV[#ARGV])');
}
