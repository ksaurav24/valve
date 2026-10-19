import { expect, it } from 'vitest';
import { mergeSafety, safetyReport } from '../../src/oracle/safety.ts';
import { checkLeases } from '../../src/oracle/server.ts';
import { decodeEvent } from '../../src/lua/log.ts';
import type { ServerEvent } from '../../src/core/types.ts';

it('keeps unknown coverage unknown across trials and never declares empty evidence passing', () => {
  expect(mergeSafety([]).status).toBe('UNVERIFIED');
  expect(safetyReport([], [], []).status).toBe('UNVERIFIED');
  const checked = safetyReport([], ['rate-bound'], []);
  const unknown = safetyReport([], ['lost-job'], ['rate-bound']);
  expect(mergeSafety([checked, unknown])).toMatchObject({
    status: 'UNVERIFIED',
    unverified: ['rate-bound'],
  });
});
it('FAIL dominates incomplete checks and safety is independent of performance', () => {
  const failure = safetyReport(
    [{ class: 'maxwait-C1-check-before-deadline', detail: 'late callback' }],
    [],
    ['rate-bound'],
  );
  expect(
    mergeSafety([failure, safetyReport([], ['rate-bound'], [])]),
  ).toMatchObject({
    status: 'FAIL',
    counts: { 'maxwait-C1-check-before-deadline': 1 },
    unverified: ['rate-bound'],
  });
});
it('decodes zero-based scoped rule refs and lease ownership through renew/release', () => {
  const decode = (
    s: string,
    k: string[],
    a: unknown[],
    r: unknown,
    t: string,
  ) => decodeEvent(JSON.stringify({ s, k, a, r, t }))!;
  const make = (owner: string, t: string) =>
    decode(
      'SCOPED',
      ['p:{q}:config', 'p:{q}:pause', 'p:{q}:leases', 'p:{q}:s:tenant:a'],
      [
        JSON.stringify({
          rules: [{ algorithm: 'gcra', intervalMs: 100, limit: 1, burst: 1 }],
          jobs: [{ cost: 1, refs: [0] }],
          lease: { limit: 1, ttlMs: 30, owner },
        }),
      ],
      [[0], {}, [[0, `${owner}:0`]], 0],
      t,
    );
  const events: ServerEvent[] = [
    make('a', '1.000000'),
    decode('RENEW', ['p:{q}:leases'], [30, 'a:0'], 1, '1.020000'),
    make('b', '1.030000'),
  ];
  expect(checkLeases(events)).toMatchObject({
    maxOccupancy: 2,
    violations: [{ class: 'lease-oversubscription' }],
  });
  events.splice(
    2,
    0,
    decode('RELEASE', ['p:{q}:leases', 'p:{q}:events'], ['a:0'], 1, '1.025000'),
  );
  expect(checkLeases(events)).toMatchObject({
    maxOccupancy: 1,
    violations: [],
  });
  expect(
    checkLeases([make('a', '1.000000'), make('b', '1.030000')]).violations,
  ).toEqual([]);
});

it('uses elapsed monotonic time for late callbacks, with the wall clock only as a diagnostic', async () => {
  const { checkClient } = await import('../../src/oracle/client.ts');
  const { Outcome } = await import('../../src/core/types.ts');
  const j = {
    w: 0,
    i: 0,
    k: 0,
    ia: 1000,
    sa: 1000,
    st: 1011,
    en: 1012,
    o: Outcome.completed,
    c: 1,
    mw: 10,
    ab: -1,
    rp: 1009,
    sd: 5000,
    sdStart: 4000,
  };
  expect(checkClient([j])).toMatchObject({
    violations: [{ class: 'maxwait-C1-check-before-deadline', magnitude: 1 }],
    lateByValveClock: 0,
  });
  expect(checkClient([{ ...j, rp: 1010 }]).violations[0]!.class).toBe(
    'maxwait-late-grant',
  );
  expect(checkClient([{ ...j, st: 1010, sdStart: 9000 }])).toMatchObject({
    violations: [],
    lateByValveClock: 1,
  });
});
