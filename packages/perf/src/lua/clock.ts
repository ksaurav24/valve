// Clock-injected copies of shipped scripts for model parity (test-only, never in measured arms).
// Mirrors packages/valve/test/lua-clock.ts: the only change is the clock expression;
// the injected clock is passed as the final ARGV in milliseconds (fractional allowed).
import { sha1 } from '../core/hash.ts';

const CLOCK = "redis.call('TIME')";

/** Replace Redis TIME with ARGV[#ARGV] (ms). Throws if the production clock changed shape. */
export function withInjectedClock(source: string): {
  source: string;
  sha: string;
} {
  const count = source.split(CLOCK).length - 1;
  if (count !== 1)
    throw new Error(`expected exactly one ${CLOCK} in script, found ${count}`);
  const injected = source.replace(
    CLOCK,
    '{math.floor(tonumber(ARGV[#ARGV])/1000),(tonumber(ARGV[#ARGV])%1000)*1000}',
  );
  return { source: injected, sha: sha1(injected) };
}
