import { describe, expect, it } from 'vitest';
import { metricsNamespace, pausedQuality, premiumPause } from '../src/platform_cap.js';

describe('premiumPause', () => {
  const now = new Date('2026-10-19T15:30:00.000Z');

  it('is off below the cap', () => {
    expect(premiumPause(1999, 2000, now)).toBeUndefined();
    expect(premiumPause(0, 2000, now)).toBeUndefined();
  });

  it('lasts until the start of next month, UTC, at and above the cap', () => {
    expect(premiumPause(2000, 2000, now)).toEqual({ until: new Date('2026-11-01T00:00:00.000Z') });
    expect(premiumPause(2500, 2000, now)?.until.toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });

  it('rolls over the year in December', () => {
    expect(premiumPause(10_000, 10_000, new Date('2026-12-31T23:59:00Z'))?.until).toEqual(
      new Date('2027-01-01T00:00:00.000Z'),
    );
  });
});

describe('pausedQuality', () => {
  it('pauses every quality but draft', () => {
    expect(pausedQuality('draft')).toBe(false);
    expect(pausedQuality('standard')).toBe(true);
    expect(pausedQuality('high')).toBe(true);
  });
});

it('names the metrics namespace per environment', () => {
  expect(metricsNamespace('dev')).toBe('Pictora/dev');
});
