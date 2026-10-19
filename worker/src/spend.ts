import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { MONTHLY_SPEND_METRIC, PLATFORM_PK, spendSk, utcMonth } from '@pictora/core';
import type { TableContext } from './job_store.js';
import { log } from './log.js';

/** Where the worker reports the month's platform spend (tech design 4.1 and 11). */
export interface SpendReporting {
  /** The monthly cap from config, recorded on the month's spend item. */
  capCents: number;
  /** The metrics namespace, `Pictora/<env>`. */
  namespace: string;
}

/**
 * An Embedded Metric Format log line: CloudWatch turns it into a metric with no dimensions, so no
 * `PutMetricData` call or permission is needed.
 */
export function spendMetricLine(namespace: string, spentCents: number, now: Date): string {
  return JSON.stringify({
    _aws: {
      Timestamp: now.getTime(),
      CloudWatchMetrics: [
        {
          Namespace: namespace,
          Dimensions: [[]],
          Metrics: [{ Name: MONTHLY_SPEND_METRIC, Unit: 'Count' }],
        },
      ],
    },
    [MONTHLY_SPEND_METRIC]: spentCents,
  });
}

/**
 * After a job's provider cost is added to `PLATFORM/SPEND#<month>`, records the configured cap on the same item
 * and publishes the month's total so far as `MonthlySpendCents`, which the 80% and 100% spend alarms watch.
 * Best effort: a failure is logged, never thrown, since the job itself is already recorded.
 */
export async function reportMonthlySpend(
  { client, tableName }: TableContext,
  spend: SpendReporting,
  now: Date,
): Promise<void> {
  try {
    const result = await client.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { PK: PLATFORM_PK, SK: spendSk(utcMonth(now)) },
        UpdateExpression: 'SET capCents = :cap',
        ExpressionAttributeValues: { ':cap': spend.capCents },
        ReturnValues: 'ALL_NEW',
      }),
    );
    const spent = result.Attributes?.spentCents;
    console.log(spendMetricLine(spend.namespace, typeof spent === 'number' ? spent : 0, now));
  } catch (error) {
    log('WARN', 'Monthly spend not reported', { error });
  }
}
