import { describe, expect, it } from 'vitest';
import {
  RATE_LIMIT_PER_MINUTE,
  TESTER_RATE_LIMIT_PER_MINUTE,
  TESTERS_GROUP,
  adminModerationQuerySchema,
  adminStatsQuerySchema,
  datesBetween,
  daysBefore,
  rateLimitPerMinute,
  reviewRequestSchema,
  userSubSchema,
  utcDateSchema,
} from '../src/index.js';

describe('admin schemas', () => {
  it('accepts real calendar days only', () => {
    expect(utcDateSchema.safeParse('2026-10-15').success).toBe(true);
    expect(utcDateSchema.safeParse('2028-02-29').success).toBe(true);
    for (const value of ['2026-02-30', '2026-13-01', '2026-1-01', '15/10/2026', '']) {
      expect(utcDateSchema.safeParse(value).success).toBe(false);
    }
  });

  it('takes an optional range and date, and nothing else', () => {
    expect(adminStatsQuerySchema.parse({})).toEqual({});
    expect(adminStatsQuerySchema.parse({ from: '2026-10-01', to: '2026-10-15' })).toEqual({
      from: '2026-10-01',
      to: '2026-10-15',
    });
    expect(adminStatsQuerySchema.safeParse({ days: '7' }).success).toBe(false);
    expect(adminModerationQuerySchema.parse({ date: '2026-10-15' })).toEqual({
      date: '2026-10-15',
    });
  });

  it('accepts the two review verdicts', () => {
    expect(reviewRequestSchema.parse({ verdict: 'ok' })).toEqual({ verdict: 'ok' });
    expect(reviewRequestSchema.parse({ verdict: 'confirmed' })).toEqual({ verdict: 'confirmed' });
    expect(reviewRequestSchema.safeParse({ verdict: 'maybe' }).success).toBe(false);
  });

  it('accepts Cognito subs and refuses anything that could leave the key', () => {
    expect(userSubSchema.safeParse('3f1c2a9e-1b2c-4d5e-8f90-a1b2c3d4e5f6').success).toBe(true);
    for (const value of ['', 'a#b', '../x', 'a/b', 'x'.repeat(129)]) {
      expect(userSubSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe('date helpers', () => {
  it('lists the days of a range, both ends included', () => {
    expect(datesBetween('2026-10-30', '2026-11-02')).toEqual([
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
    ]);
    expect(datesBetween('2026-10-15', '2026-10-15')).toEqual(['2026-10-15']);
    expect(datesBetween('2026-10-16', '2026-10-15')).toEqual([]);
  });

  it('counts days back across months', () => {
    expect(daysBefore('2026-03-01', 1)).toBe('2026-02-28');
    expect(daysBefore('2026-10-15', 13)).toBe('2026-10-02');
  });
});

describe('rateLimitPerMinute', () => {
  it('is 10 a minute for everyone outside the testers group (LIM-3)', () => {
    expect(RATE_LIMIT_PER_MINUTE).toBe(10);
    for (const groups of [[], ['admins']]) expect(rateLimitPerMinute(groups)).toBe(10);
  });

  it('is 50 a minute for the testers group', () => {
    expect(TESTER_RATE_LIMIT_PER_MINUTE).toBe(50);
    expect(rateLimitPerMinute([TESTERS_GROUP])).toBe(50);
    expect(rateLimitPerMinute(['admins', TESTERS_GROUP])).toBe(50);
  });
});
