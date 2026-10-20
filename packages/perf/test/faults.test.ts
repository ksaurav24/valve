import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import type { Redis } from 'ioredis';
import type { FaultSpec } from '../src/core/types.ts';
import type { Endpoint } from '../src/infra/safety.ts';

const state = vi.hoisted(() => ({
  commands: [] as string[][],
  children: [] as ChildProcess[],
  label: '1',
  paused: false,
  pauseError: false,
  unpauseFailures: 0,
  onUnpause: () => {},
  stallerEval: () => Promise.resolve<unknown>(1),
  stallerDisconnect: vi.fn(),
}));
vi.mock('node:child_process', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    execFileSync: (_command: string, args: string[]) => {
      state.commands.push(args);
      if (args[0] === 'inspect') {
        if (args[2]!.includes('Labels')) return state.label;
        if (args[2] === '{{.Id}}') return 'immutable-owned-id';
        if (args[2] === '{{.State.Paused}}') return String(state.paused);
      }
      if (args[0] === 'pause') {
        state.paused = true;
        if (state.pauseError) throw new Error('pause reply lost');
      }
      if (args[0] === 'unpause') {
        if (state.unpauseFailures-- > 0) throw new Error('unpause failed');
        state.paused = false;
        state.onUnpause();
      }
      return '';
    },
    spawn: () => {
      const child = Object.assign(new EventEmitter(), {
        exitCode: null,
        signalCode: null,
        kill: vi.fn(() => true),
      }) as unknown as ChildProcess;
      state.children.push(child);
      return child;
    },
  };
});
vi.mock('ioredis', () => ({
  Redis: class {
    eval = () => state.stallerEval();
    disconnect = () => state.stallerDisconnect();
  },
}));
import { FaultRunner } from '../src/infra/faults.ts';

/** Explicitly advance one async boundary without depending on wall time or scheduling. */
const tick = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const endpoint: Endpoint = {
  name: 'test-only',
  url: 'redis://test-only.invalid:6379',
  disposable: true,
  controllable: true,
  server: {
    container: 'test-only-name',
    image: 'redis:7.4',
    url: 'redis://test-only.invalid:6379',
    hostUrl: 'redis://test-only.invalid:6379',
    token: 'owned-token',
    createdAt: '',
    cpuset: null,
    netem: false,
  },
};
function admin() {
  return {
    get: vi.fn(async () => 'owned-token' as string | null),
    eval: vi.fn(async () => 1 as unknown),
    client: vi.fn(async (...args: unknown[]): Promise<string | number> => {
      if (args[0] === 'ID') return 1;
      if (args[0] === 'LIST') return 'id=2 flags=N\nid=3 flags=N';
      return 'OK';
    }),
    ping: vi.fn(async () => 'PONG'),
    set: vi.fn(async () => 'OK'),
    multi: vi.fn(),
  };
}
const pause: FaultSpec = { type: 'redis-pause', atMs: 0, ms: 60_000 };
const serverFaults: FaultSpec[] = [
  pause,
  { type: 'redis-restart', atMs: 0 },
  { type: 'client-kill', atMs: 0 },
  { type: 'redis-stall', atMs: 0, ms: 10 },
  { type: 'redis-cpu', atMs: 0, forMs: 100, duty: 1 },
  { type: 'redis-load', atMs: 0, forMs: 100, opsPerSec: 10 },
];
function runner(io = admin(), target = endpoint, audit = false) {
  return new FaultRunner(
    target,
    io as unknown as Redis,
    0,
    'test-only-prefix:',
    audit
      ? { logKey: 'test-only-log', dir: '/never-written-by-this-test' }
      : undefined,
  );
}
/** Observe whether the real barrier has settled while a controlled operation remains pending. */
function observe(promise: Promise<void>) {
  let settled = false;
  void promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  return () => settled;
}
beforeEach(() => {
  vi.useFakeTimers();
  state.commands.length = 0;
  state.children.length = 0;
  state.label = '1';
  state.paused = false;
  state.pauseError = false;
  state.unpauseFailures = 0;
  state.onUnpause = () => {};
  state.stallerEval = async () => 1;
  state.stallerDisconnect.mockClear();
});
afterEach(() => vi.useRealTimers());

describe('fault shutdown barrier', () => {
  it('is idempotent, rejects new dispatch and never controls an unused endpoint', async () => {
    const io = admin();
    const faults = runner(io);
    const stop = faults.stopAll();
    expect(faults.stopAll()).toBe(stop);
    await stop;
    await expect(faults.fire(pause)).rejects.toThrow('stopping');
    await expect(faults.prepare([pause])).rejects.toThrow('stopping');
    expect(io.get).not.toHaveBeenCalled();
    expect(state.commands).toEqual([]);
  });

  it('tracks dispatch before its first microtask and cancels it before the ownership check', async () => {
    const io = admin();
    const faults = runner(io);
    const fired = faults.fire(pause);
    await Promise.all([faults.stopAll(), fired]);
    expect(io.get).not.toHaveBeenCalled();
    expect(state.commands).toEqual([]);
  });

  it.each(serverFaults)(
    'drains a late safety check without firing $type',
    async (fault) => {
      const io = admin();
      const check = deferred<string>();
      io.get.mockReturnValue(check.promise);
      const faults = runner(io);
      const fired = faults.fire(fault);
      await tick();
      expect(io.get).toHaveBeenCalledOnce();
      const stop = faults.stopAll();
      const settled = observe(stop);
      await tick();
      expect(settled()).toBe(false);
      check.resolve('owned-token');
      await Promise.all([fired, stop]);
      expect(state.commands.every((args) => args[0] === 'inspect')).toBe(true);
      expect(state.children).toHaveLength(0);
      expect(io.eval).not.toHaveBeenCalled();
      expect(io.client).not.toHaveBeenCalled();
      expect(faults.log[0]!.error).toContain('stopping');
    },
  );

  it('drains a failed safety check and never pauses or unpauses an unowned store', async () => {
    const io = admin();
    const check = deferred<string>();
    io.get.mockReturnValue(check.promise);
    const faults = runner(io);
    const fired = faults.fire(pause);
    await tick();
    const stop = faults.stopAll();
    check.reject(new Error('ownership read failed'));
    await Promise.all([fired, stop]);
    expect(faults.log[0]!.error).toContain('ownership read failed');
    expect(state.commands.every((args) => args[0] === 'inspect')).toBe(true);
  });

  it.each(['external', 'label', 'sentinel'])(
    'preserves %s ownership rejection during dispatch and shutdown',
    async (kind) => {
      const io = admin();
      if (kind === 'label') state.label = 'not-owned';
      if (kind === 'sentinel') io.get.mockResolvedValue('someone-else');
      const faults = runner(
        io,
        kind === 'external' ? { ...endpoint, disposable: false } : endpoint,
      );
      await faults.fire(pause);
      await faults.stopAll();
      expect(faults.log[0]!.error).toContain('Refusing destructive operation');
      expect(state.commands.every((args) => args[0] === 'inspect')).toBe(true);
    },
  );

  it('settles an interrupted pause and unpauses the same immutable container before returning', async () => {
    const target = { ...endpoint, server: { ...endpoint.server! } };
    const faults = runner(admin(), target);
    const fired = faults.fire(pause);
    await tick();
    expect(state.paused).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    target.server.container = 'replacement-unowned-name';
    await Promise.all([faults.stopAll(), fired]);
    expect(state.paused).toBe(false);
    expect(state.commands).toContainEqual(['pause', 'immutable-owned-id']);
    expect(state.commands).toContainEqual(['unpause', 'immutable-owned-id']);
    expect(
      state.commands.some((args) => args.includes('replacement-unowned-name')),
    ).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('restores a pause even when the pause command loses its reply', async () => {
    state.pauseError = true;
    const faults = runner();
    await faults.fire(pause);
    await faults.stopAll();
    expect(state.paused).toBe(false);
    expect(faults.log[0]!.error).toContain('pause reply lost');
  });

  it('does not let a second pending safety check prevent restoration of an active pause', async () => {
    const io = admin();
    const faults = runner(io);
    const first = faults.fire(pause);
    await tick();
    const check = deferred<string>();
    io.get.mockReturnValue(check.promise);
    const second = faults.fire(pause);
    await tick();
    const stop = faults.stopAll();
    const settled = observe(stop);
    await tick();
    expect(state.paused).toBe(false);
    expect(settled()).toBe(false);
    check.resolve('owned-token');
    await Promise.all([first, second, stop]);
    expect(state.commands.filter((args) => args[0] === 'pause')).toHaveLength(
      1,
    );
  });

  it('retries restoration after a transient unpause failure', async () => {
    state.unpauseFailures = 1;
    const faults = runner();
    const fired = faults.fire(pause);
    await tick();
    await Promise.all([faults.stopAll(), fired]);
    expect(state.paused).toBe(false);
    expect(state.commands.filter((args) => args[0] === 'unpause')).toHaveLength(
      2,
    );
  });

  it('retries unpause before draining a safety read blocked by the paused server', async () => {
    const io = admin();
    const faults = runner(io);
    const first = faults.fire(pause);
    await tick();
    const check = deferred<string>();
    io.get.mockReturnValue(check.promise);
    state.onUnpause = () => check.resolve('owned-token');
    const second = faults.fire(pause);
    await tick();
    state.unpauseFailures = 1;
    await Promise.all([first, second, faults.stopAll()]);
    expect(state.paused).toBe(false);
    expect(state.commands.filter((args) => args[0] === 'pause')).toHaveLength(
      1,
    );
  });

  it('rejects handoff when restoration cannot be confirmed', async () => {
    state.unpauseFailures = Infinity;
    const faults = runner();
    const fired = faults.fire(pause);
    await tick();
    const stop = faults.stopAll();
    await expect(stop).rejects.toThrow('retain endpoint ownership');
    await fired;
    expect(state.paused).toBe(true);
    expect(faults.stopAll()).toBe(stop);
    await expect(faults.fire(pause)).rejects.toThrow('stopping');
  });

  it('accepts a failed unpause only if the same container is confirmed already restored', async () => {
    const faults = runner();
    const fired = faults.fire(pause);
    await tick();
    state.paused = false;
    state.unpauseFailures = Infinity;
    await Promise.all([faults.stopAll(), fired]);
    expect(state.commands).toContainEqual([
      'inspect',
      '-f',
      '{{.State.Paused}}',
      'immutable-owned-id',
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('finishes a normal pause without redundant unpause commands at shutdown', async () => {
    const faults = runner();
    const fired = faults.fire({ ...pause, ms: 100 });
    await vi.advanceTimersByTimeAsync(100);
    await fired;
    await faults.stopAll();
    expect(state.paused).toBe(false);
    expect(state.commands.filter((args) => args[0] === 'unpause')).toHaveLength(
      1,
    );
  });

  it('cancels preparation after a late check without starting Lua calibration', async () => {
    const io = admin();
    const check = deferred<string>();
    io.get.mockReturnValue(check.promise);
    const faults = runner(io);
    const prepare = expect(faults.prepare(serverFaults)).rejects.toThrow(
      'stopping',
    );
    await tick();
    const stop = faults.stopAll();
    check.resolve('owned-token');
    await Promise.all([prepare, stop]);
    expect(io.eval).not.toHaveBeenCalled();
  });

  it('drains already-started Lua calibration but starts no later stall', async () => {
    const io = admin();
    const calibration = deferred<unknown>();
    io.eval.mockReturnValue(calibration.promise);
    const faults = runner(io);
    const fired = faults.fire({ type: 'redis-stall', atMs: 0, ms: 10 });
    await tick();
    expect(io.eval).toHaveBeenCalledOnce();
    const stop = faults.stopAll();
    const settled = observe(stop);
    await tick();
    expect(settled()).toBe(false);
    calibration.resolve(1);
    await Promise.all([fired, stop]);
    expect(state.stallerDisconnect).not.toHaveBeenCalled();
    expect(faults.log[0]!.error).toContain('stopping');
  });

  it('drains an active stall and closes its client before resolving shutdown', async () => {
    const faults = runner();
    await faults.prepare([{ type: 'redis-stall', atMs: 0, ms: 10 }]);
    const evalDone = deferred<unknown>();
    state.stallerEval = () => evalDone.promise;
    const fired = faults.fire({ type: 'redis-stall', atMs: 0, ms: 10 });
    await tick();
    const stop = faults.stopAll();
    const settled = observe(stop);
    await tick();
    expect(settled()).toBe(false);
    expect(state.stallerDisconnect).not.toHaveBeenCalled();
    evalDone.resolve(1);
    await Promise.all([fired, stop]);
    expect(state.stallerDisconnect).toHaveBeenCalledOnce();
  });

  it('requires a server response after a staller loses its reply before allowing handoff', async () => {
    const io = admin();
    const ready = deferred<string>();
    io.ping.mockReturnValue(ready.promise);
    const faults = runner(io);
    await faults.prepare([{ type: 'redis-stall', atMs: 0, ms: 10 }]);
    state.stallerEval = async () => {
      throw new Error('reply connection lost');
    };
    await faults.fire({ type: 'redis-stall', atMs: 0, ms: 10 });
    const stop = faults.stopAll();
    const settled = observe(stop);
    await tick();
    expect(io.ping).toHaveBeenCalledOnce();
    expect(settled()).toBe(false);
    ready.resolve('PONG');
    await stop;
  });

  it('retains ownership if the final server fence cannot confirm recovery', async () => {
    const io = admin();
    const faults = runner(io);
    const fired = faults.fire(pause);
    await tick();
    io.ping.mockRejectedValue(new Error('server recovery unconfirmed'));
    await expect(faults.stopAll()).rejects.toThrow(
      'server recovery unconfirmed',
    );
    await fired;
    expect(state.paused).toBe(false);
  });

  it.each(['ID', 'LIST', 'KILL'])(
    'starts no further client-kill commands after shutdown during %s',
    async (stage) => {
      const io = admin();
      const pending = deferred<string | number>();
      io.client.mockImplementation(async (...args) => {
        if (args[0] === stage) return pending.promise;
        return args[0] === 'ID' ? 1 : 'id=2 flags=N\nid=3 flags=N';
      });
      const faults = runner(io);
      const fired = faults.fire({ type: 'client-kill', atMs: 0 });
      await tick();
      expect(io.client.mock.calls.at(-1)![0]).toBe(stage);
      const calls = io.client.mock.calls.length;
      const stop = faults.stopAll();
      const settled = observe(stop);
      await tick();
      expect(settled()).toBe(false);
      pending.resolve(
        stage === 'ID' ? 1 : stage === 'LIST' ? 'id=2 flags=N' : 'OK',
      );
      await Promise.all([fired, stop]);
      expect(io.client).toHaveBeenCalledTimes(calls);
    },
  );

  it('recovers an in-flight audit write pause without restarting after shutdown', async () => {
    const io = admin();
    const transaction = deferred<unknown>();
    const unpause = deferred<string>();
    const chain = {
      lrange: vi.fn(),
      time: vi.fn(),
      client: vi.fn(),
      exec: () => transaction.promise,
    };
    chain.lrange.mockReturnValue(chain);
    chain.time.mockReturnValue(chain);
    chain.client.mockReturnValue(chain);
    io.multi.mockReturnValue(chain);
    io.client.mockImplementation(() => unpause.promise);
    const faults = runner(io, endpoint, true);
    const fired = faults.fire({ type: 'redis-restart', atMs: 0 });
    await tick();
    expect(chain.client).toHaveBeenCalledWith('PAUSE', 30000, 'WRITE');
    const stop = faults.stopAll();
    const settled = observe(stop);
    transaction.resolve([]);
    await tick();
    expect(io.client).toHaveBeenCalledWith('UNPAUSE');
    expect(settled()).toBe(false);
    unpause.resolve('OK');
    await Promise.all([fired, stop]);
    expect(state.commands.some((args) => args[0] === 'restart')).toBe(false);
  });

  it('drains restart recovery and sentinel restoration before handoff', async () => {
    const io = admin();
    const reachable = deferred<string>();
    const restored = deferred<string>();
    io.ping.mockReturnValue(reachable.promise);
    io.set.mockReturnValue(restored.promise);
    const faults = runner(io);
    const fired = faults.fire({ type: 'redis-restart', atMs: 0 });
    await tick();
    expect(state.commands).toContainEqual([
      'restart',
      '-t',
      '0',
      'test-only-name',
    ]);
    const stop = faults.stopAll();
    const settled = observe(stop);
    reachable.resolve('PONG');
    await tick();
    expect(io.set).toHaveBeenCalledWith(
      '__valve_perf_disposable__',
      'owned-token',
    );
    expect(settled()).toBe(false);
    restored.resolve('OK');
    await Promise.all([fired, stop]);
  });

  it('awaits local process close, escalating an ignored SIGTERM', async () => {
    const faults = runner();
    const fired = faults.fire({
      type: 'redis-load',
      atMs: 0,
      forMs: 100,
      opsPerSec: 10,
    });
    await tick();
    const proc = state.children[0]!;
    const stop = faults.stopAll();
    const settled = observe(stop);
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(1000);
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
    proc.emit('exit', null, 'SIGKILL');
    await tick();
    expect(settled()).toBe(false);
    proc.emit('close', null, 'SIGKILL');
    await Promise.all([fired, stop]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('drains the bounded docker exec rather than abandoning a remote CPU loop', async () => {
    const faults = runner();
    const fired = faults.fire({
      type: 'redis-cpu',
      atMs: 0,
      forMs: 100,
      duty: 1,
    });
    await tick();
    const proc = state.children[0]!;
    const stop = faults.stopAll();
    const settled = observe(stop);
    await tick();
    expect(proc.kill).not.toHaveBeenCalled();
    expect(settled()).toBe(false);
    proc.emit('close', 124, null);
    await Promise.all([fired, stop]);
    expect(faults.log[0]!.error).toBeUndefined();
  });

  it('refuses handoff if the docker exec transport exits without confirming remote completion', async () => {
    const faults = runner();
    const fired = faults.fire({
      type: 'redis-cpu',
      atMs: 0,
      forMs: 100,
      duty: 1,
    });
    await tick();
    const stop = faults.stopAll();
    state.children[0]!.emit('close', 1, null);
    await expect(stop).rejects.toThrow('retain endpoint ownership');
    await fired;
  });
});
