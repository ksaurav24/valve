// Test-only clock substitution; production scripts always use Redis TIME.
export function withLuaClock(source: string): string {
  const clock = "redis.call('TIME')";
  if (!source.includes(clock))
    throw new Error(
      'Production Lua clock changed; update the parity harness explicitly.',
    );
  // Replace the clock expression so local-name minification remains covered.
  return source.replace(
    clock,
    '{math.floor(tonumber(ARGV[#ARGV])/1000),(tonumber(ARGV[#ARGV])%1000)*1000}',
  );
}
