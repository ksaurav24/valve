import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Recorder } from '../src/driver/recorder.ts';
import { expandCpus, cpuList } from '../src/supervisor/resources.ts';
import { runDir } from '../src/core/manifest.ts';

describe('supervisor input and recording bounds', () => {
  it('accepts CPU ranges and refuses malformed or unbounded ranges', () => {
    expect(expandCpus('0-2,4,7-8')).toEqual([0, 1, 2, 4, 7, 8]);
    for (const list of ['', '3-1', '-1', '1,,2', '1-x', '0-1000000000'])
      expect(() => expandCpus(list)).toThrow();
    expect(cpuList().length).toBeGreaterThan(0);
  });
  it('confines run IDs to a child of the runs directory', () => {
    for (const id of ['../escape', '/tmp/escape', '.', '..', 'a/b'])
      expect(() => runDir(id)).toThrow();
    expect(runDir('20261019T100000Z-sample')).toContain(
      '20261019T100000Z-sample',
    );
  });
  it('flushes NDJSON in order and fails explicitly at its recording budget', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'valve-recorder-'));
    try {
      const file = join(dir, 'rows.jsonl');
      const writer = new Recorder(file, 32, 1024);
      for (let i = 0; i < 20; i++) writer.write({ i });
      await writer.close();
      expect(
        (await readFile(file, 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line).i),
      ).toEqual(Array.from({ length: 20 }, (_, i) => i));
      const bounded = new Recorder(join(dir, 'bounded.jsonl'), 32, 50);
      bounded.write({ value: 'short' });
      expect(() => bounded.write({ value: 'x'.repeat(80) })).toThrow(
        'recording budget exceeded',
      );
      await bounded.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
