import { describe, expect, it } from 'vitest';
import {
  dailySummary,
  median,
  meetsTarget,
  metricTargets,
  periodMetrics,
  ttfiRequestSchema,
  windowClosed,
  type SummaryInputs,
} from '../src/index.js';

const COMPUTED_AT = new Date('2026-10-23T00:30:00.000Z');

function inputs(overrides: Partial<SummaryInputs> = {}): SummaryInputs {
  return {
    date: '2026-10-14',
    counts: {},
    ttfiMs: [],
    weekSpendCents: 0,
    weekActiveUsers: 0,
    blocksReviewed: 0,
    falseBlocks: 0,
    windowClosed: true,
    ...overrides,
  };
}

describe('dailySummary on a seeded test day', () => {
  // 2026-10-14, by hand:
  // - 10 sign-ups, 7 generated in their first hour → activation 7 / 10 = 70%
  // - 40 images made, 30 of them deleted within 7 days without a download → kept 10 / 40 = 25%
  // - times to first image 30 s, 45 s, 50 s, 90 s → p50 (45 + 50) / 2 = 47.5 s
  // - 49 jobs succeeded, 1 failed, 3 blocked → success 49 / 50 = 98% (blocks count as neither)
  // - 3 of the 10 sign-ups came back within 7 days → retention 3 / 10 = 30%
  // - $14.00 spent over the week by 8 active users → $1.75 each
  // - 50 blocks reviewed, 1 overturned → 2% false blocks
  const summary = dailySummary(
    inputs({
      counts: {
        signups: 10,
        firstSessionGenerates: 7,
        returnGenerates: 3,
        imagesGenerated: 40,
        imagesDiscarded: 30,
        imagesDownloaded: 12,
        jobsSucceeded: 49,
        jobsFailed: 1,
        jobsBlocked: 3,
      },
      ttfiMs: [90_000, 30_000, 50_000, 45_000],
      weekSpendCents: 1400,
      weekActiveUsers: 8,
      blocksReviewed: 50,
      falseBlocks: 1,
    }),
    COMPUTED_AT,
  );

  it('matches the hand calculation', () => {
    expect(summary).toEqual({
      date: '2026-10-14',
      computedAt: '2026-10-23T00:30:00.000Z',
      activation: { value: 0.7, numerator: 7, denominator: 10 },
      keepRate: { value: 0.25, numerator: 10, denominator: 40 },
      timeToFirstImage: { value: 47_500, samplesMs: [30_000, 45_000, 50_000, 90_000] },
      generationSuccess: { value: 0.98, numerator: 49, denominator: 50 },
      weekOneRetention: { value: 0.3, numerator: 3, denominator: 10 },
      costPerActiveUser: { value: 175, spendCents: 1400, activeUsers: 8 },
      falseBlocks: { value: 0.02, numerator: 1, denominator: 50 },
    });
  });

  it('judges each against the PRD targets with a 25-point daily budget', () => {
    const targets = metricTargets(25);
    expect(meetsTarget(targets.activation, 0.7)).toBe(true);
    expect(meetsTarget(targets.keepRate, 0.25)).toBe(false);
    expect(meetsTarget(targets.timeToFirstImage, 47_500)).toBe(true);
    expect(meetsTarget(targets.generationSuccess, 0.98)).toBe(true);
    expect(meetsTarget(targets.weekOneRetention, 0.3)).toBe(true);
    // ≤ 25 × 7 = 175 cents.
    expect(meetsTarget(targets.costPerActiveUser, 175)).toBe(true);
    expect(meetsTarget(targets.costPerActiveUser, 176)).toBe(false);
    // Strictly under 2%.
    expect(meetsTarget(targets.falseBlocks, 0.02)).toBe(false);
    expect(meetsTarget(targets.timeToFirstImage, 60_000)).toBe(false);
  });
});

describe('dailySummary edge cases', () => {
  it('has no values on a day with no sign-ups, jobs, samples, users or reviews', () => {
    const summary = dailySummary(inputs(), COMPUTED_AT);
    expect(summary.activation).toEqual({ value: null, numerator: 0, denominator: 0 });
    expect(summary.keepRate).toEqual({ value: null, numerator: 0, denominator: 0 });
    expect(summary.timeToFirstImage).toEqual({ value: null, samplesMs: [] });
    expect(summary.generationSuccess.value).toBeNull();
    expect(summary.weekOneRetention?.value).toBeNull();
    expect(summary.costPerActiveUser).toEqual({ value: null, spendCents: 0, activeUsers: 0 });
    expect(summary.falseBlocks.value).toBeNull();
  });

  it('treats zero generations as nothing to keep, and a day of only failures as 0% success', () => {
    const summary = dailySummary(
      inputs({ counts: { signups: 4, jobsFailed: 2, imagesDiscarded: 0 } }),
      COMPUTED_AT,
    );
    expect(summary.keepRate?.value).toBeNull();
    expect(summary.generationSuccess).toEqual({ value: 0, numerator: 0, denominator: 2 });
    expect(summary.activation).toEqual({ value: 0, numerator: 0, denominator: 4 });
  });

  it('never keeps a negative number of images', () => {
    const summary = dailySummary(
      inputs({ counts: { imagesGenerated: 2, imagesDiscarded: 3 } }),
      COMPUTED_AT,
    );
    expect(summary.keepRate).toEqual({ value: 0, numerator: 0, denominator: 2 });
  });

  it('leaves keep rate and retention out while their 7-day windows are open', () => {
    const summary = dailySummary(
      inputs({ counts: { signups: 2, imagesGenerated: 3 }, windowClosed: false }),
      COMPUTED_AT,
    );
    expect(summary.keepRate).toBeNull();
    expect(summary.weekOneRetention).toBeNull();
    expect(summary.activation.denominator).toBe(2);
  });
});

describe('windowClosed', () => {
  it('closes 8 days after the day, once the last image or sign-up has had 7 full days', () => {
    expect(windowClosed('2026-10-14', '2026-10-22')).toBe(true);
    expect(windowClosed('2026-10-15', '2026-10-22')).toBe(false);
    expect(windowClosed('2026-10-21', '2026-10-22')).toBe(false);
  });
});

describe('median', () => {
  it('takes the middle value, or the mean of the middle two', () => {
    expect(median([])).toBeNull();
    expect(median([5])).toBe(5);
    expect(median([9, 1, 5])).toBe(5);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

describe('periodMetrics', () => {
  const day = (date: string, overrides: Partial<SummaryInputs>) =>
    dailySummary(inputs({ date, ...overrides }), COMPUTED_AT);

  it('sums the parts, takes p50 over every sample, and averages the daily cost', () => {
    const period = periodMetrics([
      day('2026-10-13', {
        counts: { signups: 4, firstSessionGenerates: 4, jobsSucceeded: 9, jobsFailed: 1 },
        ttfiMs: [10_000, 20_000],
        weekSpendCents: 100,
        weekActiveUsers: 1,
      }),
      day('2026-10-14', {
        counts: { signups: 6, firstSessionGenerates: 3, imagesGenerated: 10, imagesDiscarded: 5 },
        ttfiMs: [30_000],
        weekSpendCents: 300,
        weekActiveUsers: 1,
        blocksReviewed: 10,
        falseBlocks: 1,
      }),
      // Still open: its keep rate and retention stay out of the period.
      day('2026-10-20', {
        counts: { signups: 10, returnGenerates: 10, imagesGenerated: 10 },
        windowClosed: false,
      }),
    ]);
    expect(period.activation).toEqual({ value: 7 / 20, numerator: 7, denominator: 20 });
    expect(period.keepRate).toEqual({ value: 0.5, numerator: 5, denominator: 10 });
    expect(period.timeToFirstImage).toEqual({ value: 20_000, samples: 3 });
    expect(period.generationSuccess).toEqual({ value: 0.9, numerator: 9, denominator: 10 });
    expect(period.weekOneRetention).toEqual({ value: 0, numerator: 0, denominator: 10 });
    expect(period.costPerActiveUser).toEqual({ value: 200, days: 2 });
    expect(period.falseBlocks).toEqual({ value: 0.1, numerator: 1, denominator: 10 });
  });

  it('has no values for an empty period', () => {
    const period = periodMetrics([]);
    expect(period.activation.value).toBeNull();
    expect(period.timeToFirstImage).toEqual({ value: null, samples: 0 });
    expect(period.costPerActiveUser).toEqual({ value: null, days: 0 });
  });
});

describe('ttfiRequestSchema', () => {
  it('takes whole milliseconds up to a day, and nothing else', () => {
    expect(ttfiRequestSchema.safeParse({ ms: 42_000 }).success).toBe(true);
    expect(ttfiRequestSchema.safeParse({ ms: 0 }).success).toBe(true);
    for (const body of [
      {},
      { ms: -1 },
      { ms: 1.5 },
      { ms: '42000' },
      { ms: 86_400_001 },
      { ms: 42_000, sub: 'someone-else' },
    ]) {
      expect(ttfiRequestSchema.safeParse(body).success).toBe(false);
    }
  });
});
