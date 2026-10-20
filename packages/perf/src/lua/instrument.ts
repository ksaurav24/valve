// Instrumented copies of shipped scripts for correctness arms. The shipped body runs
// inside a local function; its TIME call is tapped so the log uses the admission clock,
// including on servers before Redis 7.2. Afterwards one RPUSH records the call.
// Limitations (documented in the RFC): the log key is not declared in KEYS, so correctness
// arms refuse Redis Cluster. Production scripts are never modified on disk.
import { sha1 } from '../core/hash.ts';
import type { ScriptName, ScriptSource } from './sources.ts';

export interface InstrumentedScript {
  name: ScriptName;
  productionSha: string;
  source: string;
  sha: string;
}

/** Build an instrumented script that appends `{s,t,k,a,r}` JSON to `logKey`. */
export function instrument(
  script: ScriptSource,
  logKey: string,
): InstrumentedScript {
  if (!/^[A-Za-z0-9:{}_\-.]+$/.test(logKey))
    throw new Error(`unsafe log key: ${logKey}`);
  const body = script.source.replace(
    /redis\.call\((['"])TIME\1\)/g,
    '__clock()',
  );
  const source =
    `local __t\nlocal function __clock() __t=redis.call('TIME') return __t end\n` +
    `local function __valve() ${body}\nend\n` +
    `local __r=__valve()\n` +
    `if not __t then __t=redis.call('TIME') end\n` +
    `redis.call('RPUSH','${logKey}',cjson.encode({s='${script.name}',t=__t[1]..'.'..string.format('%06d',__t[2]),k=KEYS,a=ARGV,r=__r}))\n` +
    `return __r`;
  return {
    name: script.name,
    productionSha: script.sha,
    source,
    sha: sha1(source),
  };
}

/** Map production SHA → instrumented script, for an eval adapter to substitute. */
export function instrumentAll(
  scripts: Record<ScriptName, ScriptSource>,
  logKey: string,
  names: readonly ScriptName[] = ['ACQUIRE', 'SCOPED', 'RELEASE', 'RENEW'],
): Map<string, InstrumentedScript> {
  const map = new Map<string, InstrumentedScript>();
  for (const name of names) {
    const inst = instrument(scripts[name], logKey);
    map.set(inst.productionSha, inst);
  }
  return map;
}
