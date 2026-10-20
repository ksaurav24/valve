import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { atomicWrite } from '../src/core/files.ts';
import { acquireEndpointLock } from '../src/infra/lock.ts';
import { choose, mulberry32, zipf } from '../src/core/rng.ts';

const directories: string[] = [];
const directory = () => {
  const p = mkdtempSync(join(tmpdir(), 'valve-recovery-'));
  directories.push(p);
  return p;
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const p of directories.splice(0))
    rmSync(p, { recursive: true, force: true });
});

describe('durable state and endpoint recovery', () => {
  it('publishes complete replacements and removes temporary files on rename failure', () => {
    const dir = directory(),
      file = join(dir, 'manifest.json');
    atomicWrite(file, '{"complete":1}');
    atomicWrite(file, '{"complete":2}');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ complete: 2 });
    const blocked = join(dir, 'blocked');
    mkdirSync(blocked);
    writeFileSync(join(blocked, 'keep'), 'preserved');
    expect(() => atomicWrite(blocked, 'cannot replace a directory')).toThrow();
    expect(readdirSync(dir).sort()).toEqual(['blocked', 'manifest.json']);
    expect(readFileSync(join(blocked, 'keep'), 'utf8')).toBe('preserved');
  });
  it('recovers a dead owner, refuses a live PID, and releases only its own record', () => {
    const dead = spawnSync(process.execPath, ['-e', '']);
    expect(dead.status).toBe(0);
    const file = join(directory(), 'endpoint.lock');
    writeFileSync(file, JSON.stringify({ pid: dead.pid }));
    const release = acquireEndpointLock(file, { runId: 'replacement' });
    const value = readFileSync(file, 'utf8');
    expect(JSON.parse(value).pid).toBe(process.pid);
    expect(() => acquireEndpointLock(file)).toThrow('held by live pid');
    expect(readFileSync(file, 'utf8')).toBe(value);
    writeFileSync(
      file,
      JSON.stringify({ pid: process.pid, token: 'successor' }),
    );
    release();
    expect(JSON.parse(readFileSync(file, 'utf8')).token).toBe('successor');
  });
  it('fails closed on incomplete records, inaccessible owners, and interrupted recovery', () => {
    const file = join(directory(), 'endpoint.lock');
    writeFileSync(file, '');
    expect(() => acquireEndpointLock(file)).toThrow('no valid owner');
    writeFileSync(file, JSON.stringify({ pid: 123 }));
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
    });
    expect(() => acquireEndpointLock(file)).toThrow('permission denied');
    kill.mockImplementation(() => {
      throw Object.assign(new Error('dead'), { code: 'ESRCH' });
    });
    writeFileSync(`${file}.recover`, 'another reaper');
    expect(() => acquireEndpointLock(file)).toThrow('recovery in progress');
    expect(JSON.parse(readFileSync(file, 'utf8')).pid).toBe(123);
    expect(readdirSync(join(file, '..')).some((n) => n.endsWith('.tmp'))).toBe(
      false,
    );
  });
  it('releases a normally acquired endpoint without leaving a lock', () => {
    const dir = directory(),
      file = join(dir, 'endpoint.lock');
    acquireEndpointLock(file)();
    expect(readdirSync(dir)).toEqual([]);
  });
});

it('cached Zipf sampling preserves seeded rank streams and one draw per rank', () => {
  for (const n of [1, 10, 1000])
    for (const s of [0, 0.5, 1.5]) {
      const rnd = mulberry32(42),
        reference = mulberry32(42);
      const weights = Array.from({ length: n }, (_, i) => 1 / (i + 1) ** s);
      for (let i = 0; i < 2000; i++)
        expect(zipf(rnd, n, s)).toBe(
          s ? choose(reference, weights) : Math.floor(reference() * n),
        );
      expect(rnd()).toBe(reference());
    }
});
