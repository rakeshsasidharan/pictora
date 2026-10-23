import { z } from 'zod';
import { daysBefore } from './admin.js';

/**
 * Success metrics (PRD, Goals and success metrics; tech design 11.1). Events are counted under
 * `METRICS#<date>` / `COUNTS`; a daily job turns them into `METRICS#<date>` / `SUMMARY`, which the admin
 * dashboard reads. Nothing here leaves the table: no third-party analytics, and no personal data beyond the
 * user's `sub`.
 */

/** Metrics items expire with the daily stats. */
export const METRICS_TTL_DAYS = 400;
export const METRICS_COUNTS_SK = 'COUNTS';
export const METRICS_SUMMARY_SK = 'SUMMARY';

export function metricsPk(date: string): string {
  return `METRICS#${date}`;
}

/** A user's time to first image, on the day it was shown. */
export function ttfiSk(sub: string): string {
  return `TTFI#${sub}`;
}

/** Marks a user active on the day: one of their jobs succeeded. */
export function activeUserSk(sub: string): string {
  return `ACTIVE#${sub}`;
}

/** A job created within an hour of sign-up counts as the first session (activation). */
export const FIRST_SESSION_MS = 60 * 60 * 1000;
/** A job created after the first session and within 7 days of sign-up counts as a return (week-1 retention). */
export const RETURN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** An image deleted without a download within 7 days of being made isn't kept. */
export const KEEP_WINDOW_DAYS = 7;
/** Cost per active user is spend over a rolling week ÷ the users active in it. */
export const ACTIVE_WINDOW_DAYS = 7;
/** Time to first image is recorded only for accounts at most a day old, so it measures a new user's first visit. */
export const TTFI_ACCOUNT_AGE_MS = 24 * 60 * 60 * 1000;
/** The longest time to first image the API accepts: a day, in milliseconds. */
export const MAX_TTFI_MS = 24 * 60 * 60 * 1000;

/** `POST /api/metrics/ttfi`: milliseconds from the first page load to the first image shown. */
export const ttfiRequestSchema = z.strictObject({ ms: z.int().min(0).max(MAX_TTFI_MS) });
export type TtfiRequest = z.infer<typeof ttfiRequestSchema>;

/**
 * The counters on `METRICS#<date>` / `COUNTS`. `signups`, `firstSessionGenerates` and `returnGenerates` are
 * counted on the sign-up day, so each day's sign-ups form a cohort. `imagesDiscarded` is counted on the day the
 * image was made. The rest are counted on the day they happened.
 */
export const METRIC_COUNTERS = [
  'signups',
  'firstSessionGenerates',
  'returnGenerates',
  'jobsSucceeded',
  'jobsFailed',
  'jobsBlocked',
  'imagesGenerated',
  'imagesDownloaded',
  'imagesDiscarded',
  'firstImagesShown',
] as const;
export type MetricCounter = (typeof METRIC_COUNTERS)[number];
export type MetricCounts = Record<MetricCounter, number>;

/** The PRD's seven success metrics, in the PRD's order. */
export const METRIC_IDS = [
  'activation',
  'keepRate',
  'timeToFirstImage',
  'generationSuccess',
  'weekOneRetention',
  'costPerActiveUser',
  'falseBlocks',
] as const;
export type MetricId = (typeof METRIC_IDS)[number];

/** A share with its parts; `value` is null when there is nothing to divide by. */
export interface Ratio {
  value: number | null;
  numerator: number;
  denominator: number;
}

/** `METRICS#<date>` / `SUMMARY`. */
export interface DailySummary {
  date: string;
  computedAt: string;
  /** First-session generators ÷ sign-ups, for the day's sign-ups. */
  activation: Ratio;
  /** Images kept ÷ images made on the day; null until the day's 7-day keep window has passed. */
  keepRate: Ratio | null;
  /** p50 in milliseconds of the times to first image recorded on the day, with the samples, sorted. */
  timeToFirstImage: { value: number | null; samplesMs: number[] };
  /** Succeeded jobs ÷ (succeeded + failed) finished on the day; blocks count as neither. */
  generationSuccess: Ratio;
  /** Returning generators ÷ sign-ups, for the day's sign-ups; null until their 7 days have passed. */
  weekOneRetention: Ratio | null;
  /** Provider and enhancer spend over the 7 days ending on the day ÷ users active in them, in cents. */
  costPerActiveUser: { value: number | null; spendCents: number; activeUsers: number };
  /** Blocks reviewed `ok` ÷ blocks reviewed, for the day's blocks. */
  falseBlocks: Ratio;
}

/** What the daily job reads for one day. */
export interface SummaryInputs {
  date: string;
  counts: Partial<MetricCounts>;
  ttfiMs: number[];
  /** Spend over the 7 days ending on `date`. */
  weekSpendCents: number;
  /** Distinct users active in the 7 days ending on `date`. */
  weekActiveUsers: number;
  blocksReviewed: number;
  falseBlocks: number;
  /** True once the keep and retention windows for the day have closed (`windowClosed`). */
  windowClosed: boolean;
}

export function ratio(numerator: number, denominator: number): Ratio {
  return { value: denominator > 0 ? numerator / denominator : null, numerator, denominator };
}

/** The median (p50) of the values, the mean of the middle two for an even count; null for none. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? null)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/**
 * True once `date`'s keep and retention windows have closed on `today`: an image made, or a user signed up, at
 * the end of `date` has had the full 7 days.
 */
export function windowClosed(date: string, today: string): boolean {
  return date <= daysBefore(today, KEEP_WINDOW_DAYS + 1);
}

/** Computes a day's summary from its inputs. Pure, so running the daily job again gives the same result. */
export function dailySummary(inputs: SummaryInputs, computedAt: Date): DailySummary {
  const count = (name: MetricCounter) => inputs.counts[name] ?? 0;
  const signups = count('signups');
  const generated = count('imagesGenerated');
  const kept = Math.max(0, generated - count('imagesDiscarded'));
  return {
    date: inputs.date,
    computedAt: computedAt.toISOString(),
    activation: ratio(count('firstSessionGenerates'), signups),
    keepRate: inputs.windowClosed ? ratio(kept, generated) : null,
    timeToFirstImage: {
      value: median(inputs.ttfiMs),
      samplesMs: [...inputs.ttfiMs].sort((a, b) => a - b),
    },
    generationSuccess: ratio(count('jobsSucceeded'), count('jobsSucceeded') + count('jobsFailed')),
    weekOneRetention: inputs.windowClosed ? ratio(count('returnGenerates'), signups) : null,
    costPerActiveUser: {
      value: inputs.weekActiveUsers > 0 ? inputs.weekSpendCents / inputs.weekActiveUsers : null,
      spendCents: inputs.weekSpendCents,
      activeUsers: inputs.weekActiveUsers,
    },
    falseBlocks: ratio(inputs.falseBlocks, inputs.blocksReviewed),
  };
}

/** The metrics over a period of daily summaries: ratios of the summed parts, p50 of every sample. */
export interface PeriodMetrics {
  activation: Ratio;
  keepRate: Ratio;
  timeToFirstImage: { value: number | null; samples: number };
  generationSuccess: Ratio;
  weekOneRetention: Ratio;
  /** The mean of the days' rolling-week values, over the days that had active users. */
  costPerActiveUser: { value: number | null; days: number };
  falseBlocks: Ratio;
}

/** Combines daily summaries; days whose keep or retention window is still open are left out of those two. */
export function periodMetrics(summaries: readonly DailySummary[]): PeriodMetrics {
  const sum = (pick: (summary: DailySummary) => Ratio | null): Ratio => {
    let numerator = 0;
    let denominator = 0;
    for (const summary of summaries) {
      const part = pick(summary);
      if (!part) continue;
      numerator += part.numerator;
      denominator += part.denominator;
    }
    return ratio(numerator, denominator);
  };
  const samples = summaries.flatMap((summary) => summary.timeToFirstImage.samplesMs);
  const costs = summaries
    .map((summary) => summary.costPerActiveUser.value)
    .filter((value): value is number => value !== null);
  return {
    activation: sum((summary) => summary.activation),
    keepRate: sum((summary) => summary.keepRate),
    timeToFirstImage: { value: median(samples), samples: samples.length },
    generationSuccess: sum((summary) => summary.generationSuccess),
    weekOneRetention: sum((summary) => summary.weekOneRetention),
    costPerActiveUser: {
      value:
        costs.length > 0 ? costs.reduce((total, cost) => total + cost, 0) / costs.length : null,
      days: costs.length,
    },
    falseBlocks: sum((summary) => summary.falseBlocks),
  };
}

/** A PRD target: the value must be at least, at most, or below the bound. */
export interface MetricTarget {
  comparison: 'atLeast' | 'atMost' | 'below';
  bound: number;
}

/**
 * The PRD's v1 targets. Shares are fractions, time to first image is in milliseconds, and cost per active user
 * is in cents: at most the daily budget × 7, where the budget is the default daily points (1 point = 1 cent).
 */
export function metricTargets(dailyPoints: number): Record<MetricId, MetricTarget> {
  return {
    activation: { comparison: 'atLeast', bound: 0.7 },
    keepRate: { comparison: 'atLeast', bound: 0.35 },
    timeToFirstImage: { comparison: 'below', bound: 60_000 },
    generationSuccess: { comparison: 'atLeast', bound: 0.98 },
    weekOneRetention: { comparison: 'atLeast', bound: 0.25 },
    costPerActiveUser: { comparison: 'atMost', bound: dailyPoints * 7 },
    falseBlocks: { comparison: 'below', bound: 0.02 },
  };
}

/** Whether a value meets its target. */
export function meetsTarget(target: MetricTarget, value: number): boolean {
  if (target.comparison === 'atLeast') return value >= target.bound;
  if (target.comparison === 'atMost') return value <= target.bound;
  return value < target.bound;
}
