import { BatchGetCommand } from '@aws-sdk/lib-dynamodb';
import {
  DEFAULT_STATS_RANGE_DAYS,
  MAX_STATS_RANGE_DAYS,
  METRICS_SUMMARY_SK,
  adminStatsQuerySchema,
  datesBetween,
  daysBefore,
  metricTargets,
  metricsPk,
  periodMetrics,
  utcDate,
  type DailySummary,
  type MetricId,
  type MetricTarget,
  type PeriodMetrics,
  type Ratio,
} from '@pictora/core';
import { adminRefusal } from './admin';
import type { AdminDeps } from './admin_stats';
import { apiError, type ApiResult } from './jobs';
import type { Session } from './session';

/** One day's metrics as the dashboard shows them; the samples behind time to first image are left out. */
export interface MetricsDay {
  date: string;
  /** False until the daily job has run for the day (it runs after midnight UTC). */
  computed: boolean;
  activation: Ratio | null;
  keepRate: Ratio | null;
  timeToFirstImage: { value: number | null; samples: number } | null;
  generationSuccess: Ratio | null;
  weekOneRetention: Ratio | null;
  costPerActiveUser: { value: number | null; spendCents: number; activeUsers: number } | null;
  falseBlocks: Ratio | null;
}

/** The `GET /api/admin/metrics` body. */
export interface AdminMetricsBody {
  from: string;
  to: string;
  targets: Record<MetricId, MetricTarget>;
  /** Every day of the range, oldest first. */
  days: MetricsDay[];
  /** The whole range, from the days computed so far. */
  period: PeriodMetrics;
  /** When the newest summary in the range was computed. */
  computedAt?: string;
}

/** BatchGetItem takes at most 100 keys; a range is at most 92 days. */
const BATCH_GET_KEYS = 100;

/**
 * `GET /api/admin/metrics?from=&to=` (tech design 11.1): the PRD's success metrics per day from the
 * `METRICS#<date>` / `SUMMARY` items the daily job writes, the same metrics over the whole range (the beta
 * period, when the range is set to it), and the PRD targets. The range rules are the stats endpoint's: 14 days
 * ending today by default, at most 92.
 */
export async function getAdminMetrics(
  deps: AdminDeps,
  session: Session,
  query: Record<string, string>,
): Promise<ApiResult> {
  const refusal = adminRefusal(session);
  if (refusal) return refusal;
  const parsed = adminStatsQuerySchema.safeParse(query);
  if (!parsed.success) {
    return apiError('invalid_request', 'Use dates like 2026-10-15 for from and to.');
  }
  const to = parsed.data.to ?? utcDate(deps.now());
  const from = parsed.data.from ?? daysBefore(to, DEFAULT_STATS_RANGE_DAYS - 1);
  const dates = datesBetween(from, to);
  if (dates.length === 0)
    return apiError('invalid_request', 'The start date is after the end date.');
  if (dates.length > MAX_STATS_RANGE_DAYS) {
    return apiError('invalid_request', `Pick a range of at most ${MAX_STATS_RANGE_DAYS} days.`);
  }

  const summaries = await readSummaries(deps, dates);
  const computed = dates
    .map((date) => summaries.get(date))
    .filter((summary): summary is DailySummary => summary !== undefined);
  const body: AdminMetricsBody = {
    from,
    to,
    targets: metricTargets(deps.defaultDailyPoints),
    days: dates.map((date) => metricsDay(date, summaries.get(date))),
    period: periodMetrics(computed),
    computedAt: computed
      .map((summary) => summary.computedAt)
      .sort()
      .at(-1),
  };
  return { status: 200, body: { ...body } };
}

function metricsDay(date: string, summary: DailySummary | undefined): MetricsDay {
  if (!summary) {
    return {
      date,
      computed: false,
      activation: null,
      keepRate: null,
      timeToFirstImage: null,
      generationSuccess: null,
      weekOneRetention: null,
      costPerActiveUser: null,
      falseBlocks: null,
    };
  }
  return {
    date,
    computed: true,
    activation: summary.activation,
    keepRate: summary.keepRate,
    timeToFirstImage: {
      value: summary.timeToFirstImage.value,
      samples: summary.timeToFirstImage.samplesMs.length,
    },
    generationSuccess: summary.generationSuccess,
    weekOneRetention: summary.weekOneRetention,
    costPerActiveUser: summary.costPerActiveUser,
    falseBlocks: summary.falseBlocks,
  };
}

async function readSummaries(deps: AdminDeps, dates: string[]): Promise<Map<string, DailySummary>> {
  const found = new Map<string, DailySummary>();
  for (let start = 0; start < dates.length; start += BATCH_GET_KEYS) {
    let keys: Record<string, unknown>[] = dates
      .slice(start, start + BATCH_GET_KEYS)
      .map((date) => ({ PK: metricsPk(date), SK: METRICS_SUMMARY_SK }));
    while (keys.length > 0) {
      const result = await deps.client.send(
        new BatchGetCommand({ RequestItems: { [deps.tableName]: { Keys: keys } } }),
      );
      for (const item of result.Responses?.[deps.tableName] ?? []) {
        const summary = item as DailySummary;
        found.set(summary.date, summary);
      }
      keys = (result.UnprocessedKeys?.[deps.tableName]?.Keys ?? []) as Record<string, unknown>[];
    }
  }
  return found;
}
