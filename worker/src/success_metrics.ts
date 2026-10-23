import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  ACTIVE_WINDOW_DAYS,
  KEEP_WINDOW_DAYS,
  METRICS_COUNTS_SK,
  METRICS_SUMMARY_SK,
  METRICS_TTL_DAYS,
  SECONDS_PER_DAY,
  STATS_MODERATION_SK,
  activeUserSk,
  dailySummary,
  daysBefore,
  metricsPk,
  statsPk,
  ttfiSk,
  ttlAfter,
  utcDate,
  windowClosed,
  type DailySummary,
  type MetricCounts,
} from '@pictora/core';
import { tableContext } from './deps.js';
import type { TableContext } from './job_store.js';
import { log } from './log.js';

export interface SuccessMetricsDeps extends TableContext {
  now: () => Date;
}

/** What one day's partitions hold, as the summaries need it. */
interface DayData {
  counts: Partial<MetricCounts>;
  ttfiMs: number[];
  /** Provider spend plus enhancer overhead, in cents. */
  spendCents: number;
  blocksReviewed: number;
  falseBlocks: number;
  activeUsers: Set<string>;
}

/**
 * Computes the success metrics (tech design 11.1) for each of the 8 days before today, and stores each as
 * `METRICS#<date>` / `SUMMARY`. Yesterday gets its first summary; the older days are recomputed, so reviews of
 * their blocks are picked up, and the day 8 days back gets its keep rate and week-1 retention now that their
 * windows have closed. Every summary is computed from the counters alone, so running again gives the same result.
 */
export async function computeSummaries(deps: SuccessMetricsDeps): Promise<DailySummary[]> {
  const now = deps.now();
  const today = utcDate(now);
  const days = new Map<string, Promise<DayData>>();
  const day = (date: string) => {
    let data = days.get(date);
    if (!data) {
      data = readDay(deps, date);
      days.set(date, data);
    }
    return data;
  };

  const summaries: DailySummary[] = [];
  for (let back = 1; back <= KEEP_WINDOW_DAYS + 1; back++) {
    const date = daysBefore(today, back);
    const data = await day(date);
    const week = await Promise.all(
      Array.from({ length: ACTIVE_WINDOW_DAYS }, (_, offset) => day(daysBefore(date, offset))),
    );
    const activeUsers = new Set(week.flatMap((weekDay) => [...weekDay.activeUsers]));
    const summary = dailySummary(
      {
        date,
        counts: data.counts,
        ttfiMs: data.ttfiMs,
        weekSpendCents: week.reduce((total, weekDay) => total + weekDay.spendCents, 0),
        weekActiveUsers: activeUsers.size,
        blocksReviewed: data.blocksReviewed,
        falseBlocks: data.falseBlocks,
        windowClosed: windowClosed(date, today),
      },
      now,
    );
    await deps.client.send(
      new PutCommand({
        TableName: deps.tableName,
        Item: {
          PK: metricsPk(date),
          SK: METRICS_SUMMARY_SK,
          ...summary,
          ttl: ttlAfter(now, METRICS_TTL_DAYS * SECONDS_PER_DAY),
        },
      }),
    );
    summaries.push(summary);
  }
  return summaries;
}

async function readDay(deps: SuccessMetricsDeps, date: string): Promise<DayData> {
  const [counts, ttfi, active, stats] = await Promise.all([
    deps.client.send(
      new GetCommand({
        TableName: deps.tableName,
        Key: { PK: metricsPk(date), SK: METRICS_COUNTS_SK },
      }),
    ),
    queryAll(deps, metricsPk(date), ttfiSk('')),
    queryAll(deps, metricsPk(date), activeUserSk('')),
    queryAll(deps, statsPk(date)),
  ]);
  const number = (value: unknown) => (typeof value === 'number' ? value : 0);
  let spendCents = 0;
  let blocksReviewed = 0;
  let falseBlocks = 0;
  for (const item of stats) {
    const sk = String(item.SK);
    if (sk.startsWith('MODEL#')) spendCents += number(item.providerCostCents);
    else if (sk.startsWith('ENHANCER#')) spendCents += number(item.costCents);
    else if (sk === STATS_MODERATION_SK) {
      blocksReviewed = number(item.blocksReviewed);
      falseBlocks = number(item.falseBlocks);
    }
  }
  return {
    counts: (counts.Item ?? {}) as Partial<MetricCounts>,
    ttfiMs: ttfi.map((item) => item.ms).filter((ms): ms is number => typeof ms === 'number'),
    spendCents,
    blocksReviewed,
    falseBlocks,
    activeUsers: new Set(active.map((item) => String(item.SK).slice(activeUserSk('').length))),
  };
}

async function queryAll(
  deps: SuccessMetricsDeps,
  pk: string,
  skPrefix?: string,
): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await deps.client.send(
      new QueryCommand({
        TableName: deps.tableName,
        KeyConditionExpression: skPrefix ? 'PK = :pk AND begins_with(SK, :prefix)' : 'PK = :pk',
        ExpressionAttributeValues: { ':pk': pk, ...(skPrefix ? { ':prefix': skPrefix } : {}) },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    items.push(...(page.Items ?? []));
    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return items;
}

let deps: SuccessMetricsDeps | undefined;

/** Runs once a day from an EventBridge schedule, after midnight UTC. */
export async function handler(): Promise<{ dates: string[] }> {
  deps ??= { ...tableContext(), now: () => new Date() };
  const summaries = await computeSummaries(deps);
  log('INFO', 'Success metrics computed', {
    dates: summaries.map((summary) => summary.date),
    yesterday: summaries[0],
  });
  return { dates: summaries.map((summary) => summary.date) };
}
