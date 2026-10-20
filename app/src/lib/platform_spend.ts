import { GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { PLATFORM_PK, premiumPause, spendSk, utcMonth, type PremiumPause } from '@pictora/core';

/**
 * The premium pause in force now (tech design 4.1): the month's `PLATFORM/SPEND#<month>` spend has reached the
 * cap from config. Undefined while spend is below it.
 */
export async function readPremiumPause(
  client: DynamoDBDocumentClient,
  tableName: string,
  capCents: number,
  now: Date,
): Promise<PremiumPause | undefined> {
  const result = await client.send(
    new GetCommand({ TableName: tableName, Key: { PK: PLATFORM_PK, SK: spendSk(utcMonth(now)) } }),
  );
  const spent = result.Item?.spentCents;
  return premiumPause(typeof spent === 'number' ? spent : 0, capCents, now);
}

/** The monthly cap on provider spend from `SPEND_CAP_CENTS` (set per environment by CDK). */
export function spendCapCents(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.SPEND_CAP_CENTS);
  if (!env.SPEND_CAP_CENTS || !Number.isInteger(value) || value < 0) {
    throw new Error('SPEND_CAP_CENTS is not set');
  }
  return value;
}

/** For example `1 November`: the day premium qualities come back. */
const PAUSE_END_FORMAT = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  timeZone: 'UTC',
});

/** The user-facing message while premium qualities are paused. */
export function premiumPausedMessage(pause: PremiumPause): string {
  return `Premium models are paused until ${PAUSE_END_FORMAT.format(pause.until)} because this month's budget is used up. Draft quality still works.`;
}
