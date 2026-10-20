import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { currentBuild } from '../../src/identity/build.ts';
import { runTrial } from '../../src/supervisor/trial.ts';
import { cellHash } from '../../src/core/manifest.ts';
import { suite } from '../../src/plan/suites.ts';
import { libsCells } from '../../src/plan/libs.ts';
import { decode } from '../../src/core/codec.ts';
import type { CellSpec, JobRecord, ServerEvent } from '../../src/core/types.ts';

describe.skipIf(process.env.PERF_INTEGRATION !== '1')(
  'real worker process and Lua instrumentation',
  () => {
    for (const [category, library] of [
      ['L1-noop', 'identity'],
      ['L1-noop', 'p-queue'],
      ['D1', 'bottleneck'],
    ] as const) {
      it(`${library} ${category} completes a warmed backlog trial without recursion or setup failure`, async () => {
        const dir = await mkdtemp(join(tmpdir(), 'valve-backlog-'));
        try {
          const base = libsCells('matrix', [category]).cells.find(
            (c) => c.library === library,
          )!;
          const cell: CellSpec = {
            ...base,
            timing: { warmupMs: 50, windowMs: 100, drainMs: 100 },
          };
          const rec = await runTrial(
            {
              runId: 'integration-backlog',
              cell,
              cellHash: cellHash(cell),
              arm: {
                name: 'base',
                build: currentBuild({ rebuild: false }),
                instrument: 'none',
              },
              rep: 0,
              seed: 321,
              attempt: 1,
              fingerprintId: 'test',
            },
            { runDir: dir, authoritative: false },
          );
          expect(rec.error).toBeUndefined();
          expect(rec.status).toBe('ok');
          expect(rec.safety.status).toBe('PASS');
          const payload = decode<{ jobs: JobRecord[] }>(
            gunzipSync(await readFile(join(dir, rec.payload!))).toString(),
          );
          expect(payload.jobs.some((j) => j.st >= 0)).toBe(true);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      });
    }
    for (const server of ['redis74', 'valkey8']) {
      it(`${server} preserves both admission generations across a planned restart`, async () => {
        const dir = await mkdtemp(join(tmpdir(), 'valve-restart-'));
        try {
          const base = suite('faults')
            .risk(server)
            .find((c) => c.id.includes('restart'))!;
          const cell: CellSpec = {
            ...base,
            workers: 2,
            timing: { warmupMs: 0, windowMs: 4000, drainMs: 300 },
            faults: [{ type: 'redis-restart', atMs: 1500 }],
          };
          const rec = await runTrial(
            {
              runId: 'integration-restart',
              cell,
              cellHash: cellHash(cell),
              arm: {
                name: 'audit',
                build: currentBuild({ rebuild: false }),
                instrument: 'correctness',
              },
              rep: 0,
              seed: 123,
              attempt: 1,
              fingerprintId: 'test',
            },
            { runDir: dir, authoritative: false },
          );
          expect(rec.error).toBeUndefined();
          expect(rec.status).toBe('ok');
          expect(rec.safety.status).toBe('PASS');
          const payload = decode<{
            events: ServerEvent[];
            restartAudits: {
              file: string;
              entries: number;
              resetAt: number;
              complete: boolean;
            }[];
          }>(gunzipSync(await readFile(join(dir, rec.payload!))).toString());
          const checkpoint = payload.restartAudits[0]!;
          expect(checkpoint.complete).toBe(true);
          expect(checkpoint.entries).toBeGreaterThan(0);
          expect(
            (await readFile(checkpoint.file, 'utf8')).length,
          ).toBeGreaterThan(0);
          expect(payload.events.some((e) => e.t < checkpoint.resetAt)).toBe(
            true,
          );
          expect(payload.events.some((e) => e.t > checkpoint.resetAt)).toBe(
            true,
          );
          expect(rec.metrics.admittedPerSec).toBeGreaterThan(0);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      });
      it(`${server} records first-call grants, finishes workers, and checks the public API end to end`, async () => {
        const dir = await mkdtemp(join(tmpdir(), 'valve-trial-'));
        try {
          const base = suite('gcra').smoke(server)[0]!;
          const cell: CellSpec = {
            ...base,
            workers: 2,
            timing: { warmupMs: 0, windowMs: 500, drainMs: 200 },
            workload: {
              arrival: { kind: 'poisson', ratePerSec: 50 },
              job: { kind: 'noop' },
            },
          };
          const rec = await runTrial(
            {
              runId: 'integration',
              cell,
              cellHash: cellHash(cell),
              arm: {
                name: 'audit',
                build: currentBuild({ rebuild: false }),
                instrument: 'correctness',
              },
              rep: 0,
              seed: 123,
              attempt: 1,
              fingerprintId: 'test',
            },
            { runDir: dir, authoritative: false },
          );
          expect(rec.error).toBeUndefined();
          expect(rec.status).toBe('ok');
          expect(rec.safety.status).toBe('PASS');
          const payload = decode<{ jobs: JobRecord[]; events: ServerEvent[] }>(
            gunzipSync(await readFile(join(dir, rec.payload!))).toString(),
          );
          const starts = payload.jobs.filter((j) => j.st >= 0);
          const grants = payload.events
            .filter((e) => e.op === 'acquire')
            .reduce((sum, e) => sum + (e.op === 'acquire' ? e.granted : 0), 0);
          expect(starts.length).toBeGreaterThan(5);
          expect(grants).toBe(starts.length);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      });
    }
  },
);
