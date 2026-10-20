// Server-side fault injection on harness-owned containers. Worker crashes and joins are handled
// by the trial supervisor. Every fault returns a log entry with its measured effect.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Redis } from 'ioredis';
import type { FaultSpec } from '../core/types.ts';
import { encode } from '../core/codec.ts';
import { timeMs } from '../lua/log.ts';
import { assertDisposable, flushDisposable, type Endpoint } from './safety.ts';
import { SENTINEL_KEY } from './servers.ts';
import { epochNow } from '../core/clock.ts';

export interface FaultLog {
  type: string;
  plannedAtMs: number;
  firedAtMs: number;
  doneAtMs?: number;
  detail?: Record<string, unknown>;
  error?: string;
}

export interface RestartAudit {
  file: string;
  /** Server TIME at the atomic checkpoint; no admissions can occur until reset. */
  resetAt: number;
  entries: number;
  complete: boolean;
}

function requireContainer(endpoint: Endpoint): string {
  if (!endpoint.controllable || !endpoint.server?.container)
    throw new Error(
      `fault injection needs a harness-owned container; ${endpoint.name} is not controllable`,
    );
  return endpoint.server.container;
}

/** Busy-loop iterations per millisecond for this server (Lua TIME is frozen in 7.2+, so stalls count iterations). */
export async function calibrateStall(client: Redis): Promise<number> {
  const n = 2_000_000;
  const t0 = performance.now();
  await client.eval(
    'local x=0 for i=1,tonumber(ARGV[1]) do x=x+i end return 1',
    0,
    n,
  );
  return n / Math.max(0.1, performance.now() - t0);
}

/** Own every fault through recovery; `stopAll` is the endpoint handoff barrier. */
export class FaultRunner {
  private procs = new Map<ChildProcess, (() => void) | undefined>();
  private processErrors: Error[] = [];
  private active = new Set<Promise<void>>();
  private waits = new Map<NodeJS.Timeout, () => void>();
  private paused = new Set<string>();
  private writePaused = false;
  private touched = false;
  private stopping = false;
  private shutdown: Promise<void> | undefined;
  readonly log: FaultLog[] = [];
  readonly restartAudits: RestartAudit[] = [];
  private stallRate: number | undefined;

  constructor(
    private endpoint: Endpoint,
    private admin: Redis,
    private startAt: number,
    private keyPrefix: string,
    private restartAudit?: { logKey: string; dir: string },
  ) {}

  private now = () => epochNow() - this.startAt;

  /** No new destructive step may start after shutdown, including after a safety-check await. */
  private requireRunning() {
    if (this.stopping) throw new Error('fault runner is stopping');
  }

  /** Register work before it can yield, so shutdown also drains pending ownership checks. */
  private track(work: () => Promise<void>): Promise<void> {
    if (this.stopping)
      return Promise.reject(new Error('fault runner is stopping'));
    const pending = Promise.resolve().then(work);
    this.active.add(pending);
    void pending.then(
      () => this.active.delete(pending),
      () => this.active.delete(pending),
    );
    return pending;
  }

  /** Shutdown settles a pause's wait rather than abandoning its finally block. */
  private wait(ms: number): Promise<void> {
    if (this.stopping) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.waits.delete(timer);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      this.waits.set(timer, finish);
    });
  }

  /** Restore only the immutable container ID that this runner attempted to pause. */
  private unpause(container: string) {
    try {
      execFileSync('docker', ['unpause', container], {
        stdio: 'ignore',
        timeout: 20000,
      });
    } catch (error) {
      const paused = execFileSync(
        'docker',
        ['inspect', '-f', '{{.State.Paused}}', container],
        { encoding: 'utf8', timeout: 20000 },
      ).trim();
      if (paused !== 'false') throw error;
    }
    this.paused.delete(container);
  }

  /** A Redis write pause can have taken effect even when the transaction reply failed. */
  private async unpauseWrites() {
    await this.admin.client('UNPAUSE');
    this.writePaused = false;
  }

  private async runProcess(
    proc: ChildProcess,
    entry: FaultLog,
    expectedCodes: number[],
    cancelOnStop = true,
  ) {
    let escalation: NodeJS.Timeout | undefined;
    const cancel = () => {
      if (escalation || proc.exitCode !== null || proc.signalCode !== null)
        return;
      proc.kill('SIGTERM');
      escalation = setTimeout(() => proc.kill('SIGKILL'), 1000);
    };
    this.procs.set(proc, cancelOnStop ? cancel : undefined);
    const done = new Promise<void>((resolve) => {
      proc.once('error', (error) => {
        entry.error = String(error);
        entry.doneAtMs = this.now();
      });
      proc.once('close', (code, signal) => {
        entry.detail = { ...entry.detail, exitCode: code, signal };
        if (code === null || !expectedCodes.includes(code))
          entry.error = `fault process exited ${code ?? signal}`;
        if (!cancelOnStop && entry.error)
          this.processErrors.push(
            new Error(`remote fault completion unconfirmed: ${entry.error}`),
          );
        entry.doneAtMs = this.now();
        resolve();
      });
    });
    try {
      await done;
    } finally {
      clearTimeout(escalation);
      this.procs.delete(proc);
    }
  }

  prepare(faults: FaultSpec[]): Promise<void> {
    return this.track(async () => {
      this.requireRunning();
      if (faults.length) await assertDisposable(this.admin, this.endpoint);
      this.requireRunning();
      if (faults.some((f) => f.type === 'redis-stall')) {
        this.touched = true;
        this.stallRate = await calibrateStall(this.admin);
      }
    });
  }

  /** Fire a server fault. Worker faults (kill/spawn) are rejected here. */
  fire(f: FaultSpec): Promise<void> {
    return this.track(() => this.runFault(f));
  }

  private async runFault(f: FaultSpec): Promise<void> {
    const entry: FaultLog = {
      type: f.type,
      plannedAtMs: f.atMs,
      firedAtMs: this.now(),
    };
    this.log.push(entry);
    try {
      this.requireRunning();
      await assertDisposable(this.admin, this.endpoint);
      this.requireRunning();
      this.touched = true;
      switch (f.type) {
        case 'redis-restart': {
          const c = requireContainer(this.endpoint);
          const pauseMs = 30000;
          const pauseStartedAt = this.now();
          let checkpoint: RestartAudit | undefined;
          try {
            if (this.restartAudit) {
              // MULTI/EXEC makes the log snapshot and write pause one atomic boundary.
              // WRITE also blocks EVAL/EVALSHA. Keep the log outside the dying server;
              // merely polling LRANGE would leave an unobservable gap before the crash.
              // https://redis.io/docs/latest/commands/client-pause/
              this.writePaused = true;
              const result = await this.admin
                .multi()
                .lrange(this.restartAudit.logKey, 0, -1)
                .time()
                .client('PAUSE', pauseMs, 'WRITE')
                .exec();
              this.requireRunning();
              if (!result || result.some(([error]) => error))
                throw new Error('pre-restart audit transaction failed');
              const lines = result[0]![1] as string[];
              const time = result[1]![1] as [string, string];
              const file = join(
                this.restartAudit.dir,
                `restart-audit-${this.restartAudits.length}.json`,
              );
              writeFileSync(file, encode(lines));
              checkpoint = {
                file,
                resetAt: timeMs(`${time[0]}.${time[1]}`),
                entries: lines.length,
                complete: false,
              };
              this.restartAudits.push(checkpoint);
              entry.detail = { audit: checkpoint, writePauseMs: pauseMs };
            }
            execFileSync('docker', ['restart', '-t', '0', c], {
              stdio: 'ignore',
              timeout: 20000,
            });
            // Conservatively require restart to finish before the pause could expire.
            if (checkpoint)
              checkpoint.complete = this.now() < pauseStartedAt + pauseMs;
            // Restart without persistence empties the DB: restore the sentinel.
            await this.waitReachable();
            await this.admin.set(SENTINEL_KEY, this.endpoint.server!.token);
            entry.doneAtMs = this.now();
          } finally {
            // A failed snapshot or restart must not leave the disposable server paused.
            if (this.restartAudit) await this.unpauseWrites();
          }
          break;
        }
        case 'redis-pause': {
          const c = execFileSync(
            'docker',
            ['inspect', '-f', '{{.Id}}', requireContainer(this.endpoint)],
            { encoding: 'utf8', timeout: 20000 },
          ).trim();
          if (!c) throw new Error('fault container has no immutable ID');
          this.paused.add(c);
          try {
            execFileSync('docker', ['pause', c], {
              stdio: 'ignore',
              timeout: 20000,
            });
            await this.wait(f.ms);
          } finally {
            if (this.paused.has(c)) this.unpause(c);
          }
          entry.doneAtMs = this.now();
          break;
        }
        case 'client-kill': {
          const own = await this.admin.client('ID');
          this.requireRunning();
          const list = String(await this.admin.client('LIST'))
            .split('\n')
            .filter(Boolean)
            .map((l) =>
              Object.fromEntries(
                l.split(' ').map((kv) => kv.split('=') as [string, string]),
              ),
            );
          let killed = 0;
          for (const c of list) {
            this.requireRunning();
            if (Number(c.id) !== Number(own) && c.flags !== 'P') {
              try {
                await this.admin.client('KILL', 'ID', c.id!);
                killed++;
              } catch {
                // already gone
              }
            }
          }
          entry.detail = { killed };
          entry.doneAtMs = this.now();
          break;
        }
        case 'redis-stall': {
          const rate = this.stallRate ?? (await calibrateStall(this.admin));
          this.requireRunning();
          const staller = new Redis(this.endpoint.url);
          const t0 = performance.now();
          try {
            await staller.eval(
              'local x=0 for i=1,tonumber(ARGV[1]) do x=x+i end return 1',
              0,
              Math.round(f.ms * rate),
            );
            entry.detail = {
              requestedMs: f.ms,
              measuredMs: performance.now() - t0,
              iterationsPerMs: rate,
            };
          } finally {
            staller.disconnect();
          }
          entry.doneAtMs = this.now();
          break;
        }
        case 'redis-cpu': {
          const c = requireContainer(this.endpoint);
          // Busy shell loop inside the server's own cgroup/cpuset; duty < 1 alternates spin and sleep.
          const sec = Math.max(0.05, f.forMs / 1000);
          const sleep =
            f.duty >= 1 ? 0 : ((1 - f.duty) * 0.02) / Math.max(0.05, f.duty);
          const loop = sleep
            ? `while :; do i=0; while [ $i -lt 2000 ]; do i=$((i+1)); done; sleep ${sleep.toFixed(3)}; done`
            : 'while :; do :; done';
          const p = spawn(
            'docker',
            ['exec', c, 'timeout', String(sec), 'sh', '-c', loop],
            { stdio: 'ignore' },
          );
          entry.detail = { duty: f.duty, approximateDuty: f.duty < 1 };
          // Killing the docker CLI would leave its exec running inside the container.
          // Drain the bounded remote timeout instead before giving up endpoint ownership.
          await this.runProcess(p, entry, [0, 124], false);
          break;
        }
        case 'redis-load': {
          const script = `
            const { Redis } = await import('ioredis');
            const prefix = process.argv[2], ops = Number(process.argv[3]), until = Date.now() + Number(process.argv[4]);
            const c = new Redis(process.argv[1], { connectionName: prefix + 'fault-load' });
            let stopped = false;
            process.on('SIGTERM', () => { stopped = true; });
            let i = 0;
            while (!stopped && Date.now() < until) {
              const batch = Math.max(1, Math.round(ops / 100));
              const p = c.pipeline();
              for (let k = 0; k < batch; k++) { p.set(prefix + 'load:' + (i % 1000), 'x'); p.get(prefix + 'load:' + ((i * 7) % 1000)); i++; }
              await p.exec();
              await new Promise((r) => setTimeout(r, 10));
            }
            c.disconnect();`;
          const p = spawn(
            process.execPath,
            [
              '--input-type=module',
              '-e',
              script,
              this.endpoint.url,
              this.keyPrefix,
              String(f.opsPerSec),
              String(f.forMs),
            ],
            {
              stdio: 'ignore',
              cwd: new URL('../..', import.meta.url).pathname,
            },
          );
          await this.runProcess(p, entry, [0]);
          break;
        }
        default:
          throw new Error(
            `worker fault ${f.type} must be handled by the supervisor`,
          );
      }
    } catch (error) {
      entry.error = String(error);
      entry.doneAtMs = this.now();
    }
  }

  private async waitReachable() {
    const deadline = Date.now() + 20000;
    for (;;) {
      try {
        await this.admin.ping();
        return;
      } catch {
        if (Date.now() > deadline)
          throw new Error('server did not come back after restart');
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  }

  /** Refuse dispatch synchronously; resolve only once all work and restoration have finished. */
  stopAll(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.stopping = true;
    for (const finish of this.waits.values()) finish();
    for (const cancel of this.procs.values()) cancel?.();
    this.shutdown = this.quiesce();
    return this.shutdown;
  }

  /** Recovery failures reject the barrier, so callers must retain endpoint ownership. */
  private async quiesce() {
    // A pending sentinel read may itself be blocked by our pause. Restore before
    // draining it; failed attempts remain recorded for the fault's finally and retry below.
    for (const c of this.paused)
      try {
        this.unpause(c);
      } catch {
        // Still tracked; do not hand off unless a later restoration succeeds.
      }
    await Promise.allSettled([...this.active]);
    const errors: unknown[] = [...this.processErrors];
    for (const c of this.paused)
      try {
        this.unpause(c);
      } catch (error) {
        errors.push(error);
      }
    if (this.writePaused)
      try {
        await this.unpauseWrites();
      } catch (error) {
        errors.push(error);
      }
    if (errors.length)
      throw new AggregateError(
        errors,
        'fault recovery failed; retain endpoint ownership',
      );
    // A disconnected staller may have lost its reply while Lua still executes.
    // Confirm the server can process commands before the next trial takes ownership.
    if (this.touched) await this.admin.ping();
  }
}

export { flushDisposable };
