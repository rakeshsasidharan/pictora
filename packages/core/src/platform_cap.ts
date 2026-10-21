import type { Quality } from './registry.js';

/** The quality that keeps working once the month's platform spend reaches the cap (PRD, Global safeguards). */
export const CAP_ALLOWED_QUALITY: Quality = 'draft';

/** The spend alarms, as a percentage of the monthly cap (tech design 11). */
export const SPEND_ALARM_PERCENTS = [80, 100] as const;

/** The CloudWatch metric the worker publishes with the month's platform spend so far, in cents. */
export const MONTHLY_SPEND_METRIC = 'MonthlySpendCents';

/** The worker's metrics namespace, `Pictora/<env>` (tech design 11). */
export function metricsNamespace(envName: string): string {
  return `Pictora/${envName}`;
}

/** Premium qualities are paused until the cap resets: midnight UTC at the start of next month. */
export interface PremiumPause {
  until: Date;
}

/** The pause in force when `spentCents` has reached `capCents`; undefined below the cap. */
export function premiumPause(
  spentCents: number,
  capCents: number,
  now: Date,
): PremiumPause | undefined {
  if (spentCents < capCents) return undefined;
  return { until: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)) };
}

/** True when the quality can't be used during the pause. */
export function pausedQuality(quality: Quality): boolean {
  return quality !== CAP_ALLOWED_QUALITY;
}
