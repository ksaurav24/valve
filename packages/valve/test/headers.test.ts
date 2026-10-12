// Provider header parsing for standard Headers, records, and malformed inputs.
import { describe, expect, it } from 'vitest';
import {
  combine,
  defaultFeedback,
  ietfRateLimit,
  retryAfter,
  xRateLimit,
} from '../src/headers/index.js';
import type { FeedbackSignal } from '../src/headers/index.js';
import { compound, header, number } from '../src/headers/parse.js';
const response = (
  headers: Record<string, string | number | readonly string[] | undefined>,
  status = 429,
) => ({ status, headers });
describe('header parsing', () => {
  it('reads records without case sensitivity, arrays, numbers, and Headers', () => {
    expect(header({ 'Retry-After': ['2', '3'] }, 'retry-after')).toBe('2');
    expect(header({ 'x-limit': 0 }, 'x-limit')).toBe('0');
    expect(header(new Headers({ a: 'b' }), 'a')).toBe('b');
    expect(header(new Headers(), 'missing')).toBeUndefined();
    expect(header({}, 'missing')).toBeUndefined();
  });
  it.each(['-1', 'Infinity', 'NaN', 'bad', '', '0x10', '1e3'])(
    'ignores invalid numeric %s',
    (value) => expect(number(value)).toBeUndefined(),
  );
  it('supports compound durations', () => {
    expect(compound('1h2m3.5s')).toBe(3723500);
    expect(compound('250ms')).toBe(250);
    expect(compound('6m0s')).toBe(360000);
    expect(compound('bad')).toBeUndefined();
    expect(compound(undefined)).toBeUndefined();
  });
});
describe('feedback', () => {
  it('reads Retry-After seconds, dates relative to Date, and ignores other statuses', () => {
    const f = retryAfter();
    expect(f(response({ 'retry-after': '1.5' }))).toEqual({ pauseMs: 1500 });
    expect(f(response({ 'retry-after': '0' }))).toEqual({ pauseMs: 0 });
    expect(
      f(
        response(
          {
            date: 'Wed, 07 Oct 2026 00:00:00 GMT',
            'retry-after': 'Wed, 07 Oct 2026 00:00:20 GMT',
          },
          503,
        ),
      ),
    ).toEqual({ pauseMs: 20000 });
    expect(f(response({ 'retry-after': '-1' }))).toBeUndefined();
    expect(f(response({ 'retry-after': 'bad' }))).toBeUndefined();
    expect(f(response({}, 429))).toBeUndefined();
    expect(f(response({ 'retry-after': '2' }, 200))).toBeUndefined();
    expect(
      f(response({ 'retry-after': 'Wed, 01 Jan 2020 00:00:00 GMT' })),
    ).toEqual({ pauseMs: 0 });
  });
  it('reads IETF structured and legacy fields, choosing the longest exhausted window', () => {
    const f = ietfRateLimit();
    expect(
      f(
        response({
          ratelimit:
            '"per-second";r=10;t=1, "per-hour";r=0;t=300, "other";r=0;t=10',
        }),
      ),
    ).toEqual({ remaining: 0, resetMs: 300000 });
    expect(f(response({ ratelimit: '"x";r=3;t=10' }))).toEqual({
      remaining: 3,
      resetMs: 10000,
    });
    expect(
      f(response({ 'RateLimit-Remaining': 0, 'RateLimit-Reset': 2 })),
    ).toEqual({ remaining: 0, resetMs: 2000 });
    expect(f(response({ 'ratelimit-remaining': '3' }))).toEqual({
      remaining: 3,
    });
    expect(f(response({ 'ratelimit-reset': '4' }))).toEqual({ resetMs: 4000 });
    expect(f(response({ ratelimit: 'invalid;r=no;t=-1' }))).toBeUndefined();
    expect(f(response({}))).toBeUndefined();
  });
  it('reads draft-11 service limits without an effective window', () => {
    const f = ietfRateLimit();
    expect(
      f(response({ ratelimit: '"default";r=999;pk=:dHJpYWwxMjEzMjM=:' }, 200)),
    ).toEqual({ remaining: 999 });
    expect(f(response({ ratelimit: '"default";r=0' }))).toEqual({
      remaining: 0,
    });
    expect(f(response({ ratelimit: '"default";r=50;t=30' }, 200))).toEqual({
      remaining: 50,
      resetMs: 30000,
    });
    expect(f(response({ ratelimit: '"default";r=0;t=0' }))).toEqual({
      remaining: 0,
      resetMs: 0,
    });
    expect(
      f(response({ ratelimit: '"available";r=50;t=30, "exhausted";r=0' })),
    ).toEqual({ remaining: 0 });
    expect(
      f(response({ ratelimit: '"unknown";r=0, "timed";r=0;t=5' })),
    ).toEqual({ remaining: 0, resetMs: 5000 });
    expect(
      f(response({ ratelimit: '"timed";r=0;t=5, "unknown";r=0' })),
    ).toEqual({ remaining: 0, resetMs: 5000 });
    expect(
      f(
        response({
          ratelimit: '"default";r=999999999999999;t=999999999999999',
        }),
      ),
    ).toEqual({ remaining: 999999999999999, resetMs: 999999999999999000 });
  });
  it.each([
    '"default";r=0.5;t=10',
    '"default";r=0;t=1.5',
    '"default";r=-1;t=10',
    '"default";r=0;t=-1',
    '"default";r=0;t=no',
    '"default";r=0;t=',
    '"default";r=0;t',
    '"default";r=1000000000000000;t=10',
    '"default";r=0;t=1000000000000000',
    '"default";t=10',
    '"default";R=0;t=10',
  ])('ignores invalid draft-11 numeric parameters: %s', (ratelimit) => {
    expect(ietfRateLimit()(response({ ratelimit }))).toBeUndefined();
  });
  it.each([
    ['seconds', '2', 2000],
    ['ms', '250', 250],
    ['duration', '1m30s', 90000],
    ['epoch-seconds', '1791331202', 2000],
    ['epoch-ms', '1791331202000', 2000],
    ['auto', '1791331202000', 2000],
    ['auto', '1791331202', 2000],
    ['auto', '2', 2000],
    ['auto', '250ms', 250],
  ] as const)('reads x reset %s', (resetUnit, value, resetMs) => {
    expect(
      xRateLimit({ resetUnit })(
        response({
          date: 'Wed, 07 Oct 2026 00:00:00 GMT',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': value,
        }),
      ),
    ).toEqual({ remaining: 0, resetMs });
  });
  it('supports custom and alternate x header names', () => {
    expect(
      xRateLimit()(
        response({
          'x-rate-limit-remaining': ['0'],
          'x-rate-limit-reset': '2',
        }),
      ),
    ).toEqual({ remaining: 0, resetMs: 2000 });
    expect(
      xRateLimit({ remaining: 'x-left', reset: 'x-reset' })(
        response({ 'x-left': '4', 'x-reset': '3' }),
      ),
    ).toEqual({ remaining: 4, resetMs: 3000 });
    expect(xRateLimit()(response({ 'x-ratelimit-remaining': 2 }))).toEqual({
      remaining: 2,
    });
    expect(xRateLimit()(response({ 'x-ratelimit-reset': '2' }))).toEqual({
      resetMs: 2000,
    });
    expect(xRateLimit()(response({}))).toBeUndefined();
  });
  it('combines the longest pause and keeps the first quota pair', () => {
    const f = combine(
      () => undefined,
      () => ({ pauseMs: 1, remaining: 2 }),
      () => ({ pauseMs: 2, remaining: 3, resetMs: 4 }),
    );
    expect(f(response({}))).toEqual({ pauseMs: 2, remaining: 2 });
    expect(combine()(response({}))).toBeUndefined();
    expect(defaultFeedback(response({ 'retry-after': '2' }))).toEqual({
      pauseMs: 2000,
    });
  });
  it.each([200, 429, 503])(
    'honors an exhausted later header family on status %s',
    (status) => {
      expect(
        defaultFeedback(
          response(
            {
              RateLimit: 'r=10;t=60',
              'X-RateLimit-Remaining': '0',
              'X-RateLimit-Reset': '120',
            },
            status,
          ),
        ),
      ).toEqual({ remaining: 0, resetMs: 120000 });
    },
  );
  it.each([
    [
      { remaining: 0, resetMs: 60 },
      { remaining: 0, resetMs: 120 },
      { remaining: 0, resetMs: 120 },
    ],
    [
      { remaining: 0, resetMs: 120 },
      { remaining: 0, resetMs: 60 },
      { remaining: 0, resetMs: 120 },
    ],
    [{ remaining: 0 }, { remaining: 10, resetMs: 120 }, { remaining: 0 }],
    [{ resetMs: 120 }, { remaining: 0 }, { remaining: 0 }],
    [{ remaining: 10 }, { resetMs: 120 }, { remaining: 10 }],
    [
      { remaining: 0 },
      { remaining: 0, resetMs: 60 },
      { remaining: 0, resetMs: 60 },
    ],
    [
      { remaining: 0, resetMs: 60 },
      { remaining: 0 },
      { remaining: 0, resetMs: 60 },
    ],
    [
      { remaining: 0, resetMs: 0 },
      { remaining: 0, resetMs: 60 },
      { remaining: 0, resetMs: 60 },
    ],
    [
      { remaining: 10, resetMs: 120 },
      { remaining: 0, resetMs: 60 },
      { remaining: 0, resetMs: 60 },
    ],
    [
      { remaining: 0, resetMs: 60 },
      { remaining: 10, resetMs: 120 },
      { remaining: 0, resetMs: 60 },
    ],
    [
      { remaining: 10, resetMs: 120 },
      { remaining: 5, resetMs: 60 },
      { remaining: 10, resetMs: 120 },
    ],
    [
      { pauseMs: 10 },
      { remaining: 0, resetMs: 60 },
      { pauseMs: 10, remaining: 0, resetMs: 60 },
    ],
    [
      { pauseMs: 120 },
      { remaining: 0, resetMs: 60 },
      { pauseMs: 120, remaining: 0, resetMs: 60 },
    ],
    [
      { pauseMs: 10 },
      { remaining: 10, resetMs: 60 },
      { pauseMs: 10, remaining: 10, resetMs: 60 },
    ],
    [
      { remaining: -1, resetMs: 60 },
      { remaining: 10, resetMs: 120 },
      { remaining: -1, resetMs: 60 },
    ],
    [
      { pauseMs: 10, remaining: 0 },
      { resetMs: 120 },
      { pauseMs: 10, remaining: 0 },
    ],
  ] satisfies [FeedbackSignal, FeedbackSignal, FeedbackSignal][])(
    'selects a whole quota pair and preserves explicit pauses: %j / %j',
    (first, second, expected) => {
      const before = [{ ...first }, { ...second }];
      expect(
        combine(
          () => first,
          () => second,
        )(response({})),
      ).toEqual(expected);
      expect([first, second]).toEqual(before);
    },
  );
  it('ignores malformed resets without borrowing a different family window', () => {
    expect(
      defaultFeedback(
        response(
          {
            RateLimit: 'r=10;t=60',
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': 'bad',
          },
          200,
        ),
      ),
    ).toEqual({ remaining: 0 });
    expect(
      defaultFeedback(
        response({
          RateLimit: 'r=bad;t=60',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': '120',
        }),
      ),
    ).toEqual({ remaining: 0, resetMs: 120000 });
  });
  it('preserves single-reader signals and supports nested combinations', () => {
    for (const signal of [
      {},
      { remaining: 0 },
      { resetMs: 60 },
      { remaining: 0, resetMs: 60 },
      { pauseMs: 120 },
    ])
      expect(combine(() => signal)(response({}))).toEqual(signal);
    expect(
      combine(defaultFeedback, () => ({ remaining: 0, resetMs: 180000 }))(
        response({
          'retry-after': '10',
          RateLimit: 'r=0;t=60',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': '120',
        }),
      ),
    ).toEqual({ pauseMs: 10000, remaining: 0, resetMs: 180000 });
  });
});
