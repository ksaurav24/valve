import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BuildIdentity } from '../core/types.ts';

/** Fresh Node processes, without tsx or benchmark code from the measured revision. */
export function sampleProcess(
  script: string,
  timeout = 60000,
): Record<string, unknown> {
  const child = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', script],
    {
      encoding: 'utf8',
      timeout,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (child.error || child.status !== 0)
    throw (
      child.error ??
      new Error(child.stderr || `Measurement exited ${child.status}`)
    );
  return JSON.parse(child.stdout) as Record<string, unknown>;
}

export function startupSample(
  artifact: BuildIdentity,
  entry: 'core' | 'redis' | 'headers',
) {
  const url = pathToFileURL(
    join(
      artifact.packageDir,
      'dist',
      entry === 'core' ? 'index.js' : `${entry}/index.js`,
    ),
  ).href;
  return sampleProcess(`
    const cpu = process.cpuUsage();
    const before = process.memoryUsage();
    const start = performance.now();
    const lib = await import(${JSON.stringify(url)});
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
  `);
}

/** Public store wrapper only; the measured scheduler is never rewritten to add trace hooks. */
export function driftSample(
  artifact: BuildIdentity,
  jobs: number,
  responseMs: number,
) {
  const url = pathToFileURL(join(artifact.packageDir, 'dist/index.js')).href;
  return sampleProcess(
    `
    import { monitorEventLoopDelay, PerformanceObserver } from 'node:perf_hooks';
    const { createValve, memoryStore } = await import(${JSON.stringify(url)});
    const jobs = ${jobs}, responseMs = ${responseMs};
    const distribution = values => {
      const xs = [...values].sort((a,b) => a-b);
      return {p50:xs[Math.floor(xs.length*.5)]??0,p99:xs[Math.min(xs.length-1,Math.floor(xs.length*.99))]??0,max:xs.at(-1)??0};
    };
    const store = memoryStore();
    const acquireSync = store.acquireSync.bind(store);
    let acquisitions = 0;
    store.acquireSync = request => { acquisitions++; return acquireSync(request); };
    if (responseMs) {
      delete store.acquireSync;
      store.acquire = async request => {
        acquisitions++;
        const result = acquireSync(request);
        await new Promise(resolve => setTimeout(resolve,responseMs));
        return result;
      };
    }
    const options = {concurrency:16,rate:{limit:100,interval:1000},store};
    const warmup = createValve({...options,id:'warmup'});
    await Promise.all(Array.from({length:32},()=>warmup.run(()=>undefined)));
    await warmup.close();
    acquisitions = 0;
    const valve = createValve({...options,id:'drift'});
    const starts = [], waits = [], services = [], collections = [];
    const lag = monitorEventLoopDelay({resolution:1});
    const observer = new PerformanceObserver(list => collections.push(...list.getEntries().map(e=>e.duration)));
    observer.observe({entryTypes:['gc']}); lag.enable();
    const cpuStart = process.cpuUsage(), began = performance.now();
    let elapsedMs, cpu;
    try {
      await Promise.all(Array.from({length:jobs},()=>{
        const queued = performance.now();
        return valve.run(()=>{
          const started = performance.now(); starts.push(started);
          waits.push(started-queued); services.push(performance.now()-started);
        });
      }));
      elapsedMs = performance.now()-began; cpu = process.cpuUsage(cpuStart);
    } finally { await valve.close(); await store.close(); }
    lag.disable(); await new Promise(resolve=>setImmediate(resolve)); observer.disconnect();
    const gaps = starts.slice(1).map((t,i)=>t-starts[i]);
    console.log(JSON.stringify({jobs,responseMs,completed:starts.length,elapsedMs,
      throughput:jobs*1000/elapsedMs,queueWaitMs:distribution(waits),serviceMs:distribution(services),
      spacingOvershootMs:distribution(gaps.map(g=>Math.max(0,g-10))),
      idealSequenceDelayMs:distribution(starts.map((t,i)=>t-starts[0]-i*10)),
      minCallbackGapMs:gaps.length?Math.min(...gaps):null,acquisitions,
      cpuMs:(cpu.user+cpu.system)/1000,peakRssKiB:process.resourceUsage().maxRSS,
      heapUsedAfterBytes:process.memoryUsage().heapUsed,
      gc:{count:collections.length,durationMs:collections.reduce((a,b)=>a+b,0)},
      eventLoopDelayMs:{p50:lag.percentile(50)/1e6,p99:lag.percentile(99)/1e6,max:lag.max/1e6}}));
  `,
    Math.max(60000, jobs * 50 + 30000),
  );
}
