import { execFileSync } from 'node:child_process';
import { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import { FaultRunner } from '../../src/infra/faults.ts';
import { acquireEndpointLock } from '../../src/infra/lock.ts';
import { endpointLockPath, resolveEndpoint } from '../../src/infra/safety.ts';

describe.skipIf(process.env.PERF_INTEGRATION !== '1')(
  'disposable-container fault recovery',
  () => {
    for (const name of ['redis74', 'valkey8'])
      it(`${name} settles an interrupted pause before client and lock handoff`, async () => {
        const endpoint = resolveEndpoint(name);
        const path = endpointLockPath(endpoint.url);
        const release = acquireEndpointLock(path);
        const io = new Redis(endpoint.url, { maxRetriesPerRequest: 0 });
        const faults = new FaultRunner(endpoint, io, 0, 'fault-recovery-test:');
        try {
          const fired = faults.fire({
            type: 'redis-pause',
            atMs: 0,
            ms: 60_000,
          });
          const deadline = performance.now() + 5000;
          while (
            execFileSync(
              'docker',
              [
                'inspect',
                '-f',
                '{{.State.Paused}}',
                endpoint.server!.container!,
              ],
              { encoding: 'utf8' },
            ).trim() !== 'true'
          ) {
            if (performance.now() >= deadline)
              throw new Error('fault did not pause the disposable container');
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          await faults.stopAll();
          await fired;
          expect(faults.log[0]!.error).toBeUndefined();
          expect(
            execFileSync(
              'docker',
              [
                'inspect',
                '-f',
                '{{.State.Paused}}',
                endpoint.server!.container!,
              ],
              { encoding: 'utf8' },
            ).trim(),
          ).toBe('false');
          expect(await io.ping()).toBe('PONG');
          expect(() => acquireEndpointLock(path)).toThrow('held by live pid');
          await expect(
            faults.fire({ type: 'client-kill', atMs: 0 }),
          ).rejects.toThrow('stopping');
        } finally {
          await faults.stopAll();
          io.disconnect();
          release();
        }
        const nextRelease = acquireEndpointLock(path);
        nextRelease();
      });
  },
);
