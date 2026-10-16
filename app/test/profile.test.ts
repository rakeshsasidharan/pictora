import { describe, expect, it } from 'vitest';
import { dailyLimit, defaultDailyPoints, inCooldown } from '../src/lib/profile';

const env = (DAILY_POINTS?: string) => ({ DAILY_POINTS }) as unknown as NodeJS.ProcessEnv;

describe('defaultDailyPoints', () => {
  it('reads DAILY_POINTS, set per environment by CDK', () => {
    expect(defaultDailyPoints(env('1000'))).toBe(1000);
    expect(defaultDailyPoints(env('0'))).toBe(0);
  });

  it('falls back to 25 when unset or invalid', () => {
    expect(defaultDailyPoints(env())).toBe(25);
    expect(defaultDailyPoints(env(''))).toBe(25);
    expect(defaultDailyPoints(env('lots'))).toBe(25);
    expect(defaultDailyPoints(env('-3'))).toBe(25);
    expect(defaultDailyPoints(env('2.5'))).toBe(25);
  });
});

describe('dailyLimit', () => {
  it("uses the profile's dailyPoints override, else the default (ADM-5)", () => {
    expect(dailyLimit({ dailyPoints: 5 }, 25)).toBe(5);
    expect(dailyLimit({ dailyPoints: 0 }, 25)).toBe(0);
    expect(dailyLimit({}, 25)).toBe(25);
  });
});

describe('inCooldown', () => {
  const now = new Date('2026-10-15T12:00:00Z');

  it('is in force until cooldownUntil', () => {
    expect(inCooldown({ cooldownUntil: '2026-10-15T12:00:01.000Z' }, now)).toBe(true);
    expect(inCooldown({ cooldownUntil: '2026-10-15T12:00:00.000Z' }, now)).toBe(false);
    expect(inCooldown({}, now)).toBe(false);
  });
});
