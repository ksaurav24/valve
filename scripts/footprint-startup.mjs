// Cold imports run in isolated processes, in alternating baseline/current pairs.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cpus } from 'node:os';
const [baseline, current, output] = process.argv.slice(2);
if (!baseline || !current || !output)
  throw new Error('Usage: footprint-startup.mjs BASE CURRENT OUTPUT');
const samples = [];
for (let pair = 0; pair < 3; pair++) {
  for (const variant of pair % 2
    ? ['current', 'baseline']
    : ['baseline', 'current']) {
    for (const entry of ['core', 'redis', 'headers']) {
      const path = pathToFileURL(
        resolve(
          variant === 'baseline' ? baseline : current,
          'packages/valve/dist',
          entry === 'core' ? 'index.js' : `${entry}/index.js`,
        ),
      ).href;
      for (let run = 0; run < 10; run++) {
        const script = `
          const cpu = process.cpuUsage();
          const before = process.memoryUsage();
          const start = performance.now();
          const lib = await import(${JSON.stringify(path)});
          const imported = performance.now();
          const value = ${
            entry === 'core'
              ? "lib.createValve({id:'startup',concurrency:16})"
              : entry === 'redis'
                ? 'lib.redisStore({adapter:{eval:async()=>1,evalsha:async()=>1}})'
                : 'lib.retryAfter()'
          };
          const initialized = performance.now();
          const after = process.memoryUsage();
          const usage = process.cpuUsage(cpu);
          await value.close?.();
          console.log(JSON.stringify({importMs:imported-start,initMs:initialized-imported,
            cpuMs:(usage.user+usage.system)/1000,heapDeltaBytes:after.heapUsed-before.heapUsed,
            rssBytes:after.rss,maxRssBytes:process.resourceUsage().maxRSS*1024}));
        `;
        const result = spawnSync(
          process.execPath,
          ['--input-type=module', '--eval', script],
          { encoding: 'utf8' },
        );
        if (result.error || result.status !== 0)
          throw result.error ?? new Error(result.stderr);
        samples.push({
          pair,
          variant,
          entry,
          run,
          ...JSON.parse(result.stdout),
        });
      }
    }
  }
}
writeFileSync(
  output,
  JSON.stringify(
    {
      node: process.version,
      cpu: cpus()[0].model,
      baseline: resolve(baseline),
      current: resolve(current),
      protocol:
        '3 alternating pairs, 10 fresh processes per entry per pair; filesystem cache shared; no discarded samples',
      samples,
    },
    null,
    2,
  ) + '\n',
);
