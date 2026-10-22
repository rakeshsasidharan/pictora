import { metricTargets } from '@pictora/core';
import type { AdminMetricsBody, MetricsDay } from '../src/lib/admin_metrics';

const ratio = (numerator: number, denominator: number) => ({
  value: denominator > 0 ? numerator / denominator : null,
  numerator,
  denominator,
});

/** A computed day: activation, success and false blocks on target; keep rate and retention still open. */
export const COMPUTED_DAY: MetricsDay = {
  date: '2026-10-14',
  computed: true,
  activation: ratio(7, 10),
  keepRate: null,
  timeToFirstImage: { value: 47_500, samples: 4 },
  generationSuccess: ratio(49, 50),
  weekOneRetention: null,
  costPerActiveUser: { value: 175, spendCents: 1400, activeUsers: 8 },
  falseBlocks: ratio(1, 100),
};

/** `GET /api/admin/metrics` for 2026-10-14 to 2026-10-15, the 15th not computed yet. */
export function metricsBody(overrides: Partial<AdminMetricsBody> = {}): AdminMetricsBody {
  return {
    from: '2026-10-14',
    to: '2026-10-15',
    targets: metricTargets(25),
    days: [
      COMPUTED_DAY,
      {
        date: '2026-10-15',
        computed: false,
        activation: null,
        keepRate: null,
        timeToFirstImage: null,
        generationSuccess: null,
        weekOneRetention: null,
        costPerActiveUser: null,
        falseBlocks: null,
      },
    ],
    period: {
      activation: ratio(7, 10),
      // Below the 35% target.
      keepRate: ratio(10, 40),
      timeToFirstImage: { value: 47_500, samples: 4 },
      // Below the 98% target.
      generationSuccess: ratio(45, 50),
      weekOneRetention: ratio(0, 0),
      costPerActiveUser: { value: 175, days: 1 },
      falseBlocks: ratio(1, 100),
    },
    computedAt: '2026-10-15T00:30:12.000Z',
    ...overrides,
  };
}
