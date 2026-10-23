import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { PROFILE_SK, SECONDS_PER_DAY, ttlAfter, userPk, utcDate, versionSk } from './jobs.js';
import {
  FIRST_SESSION_MS,
  KEEP_WINDOW_DAYS,
  METRICS_COUNTS_SK,
  METRICS_TTL_DAYS,
  RETURN_WINDOW_MS,
  TTFI_ACCOUNT_AGE_MS,
  activeUserSk,
  metricsPk,
  ttfiSk,
  type MetricCounter,
} from './metrics.js';

/** The single table and a client for it. */
export interface MetricsTable {
  client: DynamoDBDocumentClient;
  tableName: string;
}

/** The parameters of an update that adds to counters on `METRICS#<date>` / `COUNTS`. */
export interface CountsUpdate {
  TableName: string;
  Key: { PK: string; SK: string };
  UpdateExpression: string;
  ExpressionAttributeNames: Record<string, string>;
  ExpressionAttributeValues: Record<string, number>;
}

/**
 * Adds to counters on `METRICS#<date>` / `COUNTS`, setting its 400-day TTL. Usable on its own or as a
 * transaction item, so a job's counts are written with the job's final status, exactly once.
 */
export function metricsCountsUpdate(
  tableName: string,
  date: string,
  counters: Partial<Record<MetricCounter, number>>,
  now: Date,
): CountsUpdate {
  const names: Record<string, string> = { '#ttl': 'ttl' };
  const values: Record<string, number> = {
    ':ttl': ttlAfter(now, METRICS_TTL_DAYS * SECONDS_PER_DAY),
  };
  const adds = Object.entries(counters).map(([name, value], index) => {
    names[`#c${index}`] = name;
    values[`:c${index}`] = value;
    return `#c${index} :c${index}`;
  });
  return {
    TableName: tableName,
    Key: { PK: metricsPk(date), SK: METRICS_COUNTS_SK },
    UpdateExpression: `ADD ${adds.join(', ')} SET #ttl = if_not_exists(#ttl, :ttl)`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  };
}

/** Adds to the day's counters. */
export async function addMetricCounts(
  { client, tableName }: MetricsTable,
  date: string,
  counters: Partial<Record<MetricCounter, number>>,
  now: Date,
): Promise<void> {
  if (Object.keys(counters).length === 0) return;
  await client.send(new UpdateCommand(metricsCountsUpdate(tableName, date, counters, now)));
}

/**
 * Sets a marker on the profile and adds to counters in one transaction, only if the marker isn't set yet, so
 * each user is counted once whatever the retries. Returns false when it was already set.
 */
async function markOnce(
  { client, tableName }: MetricsTable,
  sub: string,
  marker: string,
  now: Date,
  counts: { date: string; counters: Partial<Record<MetricCounter, number>> },
  extra: NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']> = [],
): Promise<boolean> {
  try {
    await client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: tableName,
              Key: { PK: userPk(sub), SK: PROFILE_SK },
              UpdateExpression: 'SET #marker = :now',
              ConditionExpression: 'attribute_exists(PK) AND attribute_not_exists(#marker)',
              ExpressionAttributeNames: { '#marker': marker },
              ExpressionAttributeValues: { ':now': now.toISOString() },
            },
          },
          { Update: metricsCountsUpdate(tableName, counts.date, counts.counters, now) },
          ...extra,
        ],
      }),
    );
    return true;
  } catch (error) {
    if (
      error instanceof TransactionCanceledException &&
      error.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed'
    ) {
      return false;
    }
    throw error;
  }
}

/** `signup`: counted once, on the day the profile was created. */
export function recordSignup(table: MetricsTable, sub: string, now: Date): Promise<boolean> {
  return markOnce(table, sub, 'signupCountedAt', now, {
    date: utcDate(now),
    counters: { signups: 1 },
  });
}

/** What happened for the user when one of their jobs succeeded. */
export interface GenerationEvents {
  firstSession: boolean;
  returned: boolean;
}

/**
 * Records a user's succeeded job: marks them active today (cost per active user), and, counted on their
 * sign-up day, `first_session_generate` for a job created within an hour of sign-up (activation) or
 * `return_generate_7d` for one created later but within 7 days (week-1 retention), each once per user.
 */
export async function recordGeneration(
  table: MetricsTable,
  sub: string,
  jobCreatedAt: string,
  now: Date,
): Promise<GenerationEvents> {
  await table.client.send(
    new PutCommand({
      TableName: table.tableName,
      Item: {
        PK: metricsPk(utcDate(now)),
        SK: activeUserSk(sub),
        ttl: ttlAfter(now, METRICS_TTL_DAYS * SECONDS_PER_DAY),
      },
    }),
  );
  const profile = await table.client.send(
    new GetCommand({
      TableName: table.tableName,
      Key: { PK: userPk(sub), SK: PROFILE_SK },
      ProjectionExpression: 'createdAt, firstSessionAt, returnedAt',
    }),
  );
  const item = profile.Item as
    { createdAt?: string; firstSessionAt?: string; returnedAt?: string } | undefined;
  const events: GenerationEvents = { firstSession: false, returned: false };
  if (!item?.createdAt) return events;
  const signedUp = new Date(item.createdAt);
  const after = new Date(jobCreatedAt).getTime() - signedUp.getTime();
  const signUpDay = utcDate(signedUp);
  if (after >= 0 && after <= FIRST_SESSION_MS && !item.firstSessionAt) {
    events.firstSession = await markOnce(table, sub, 'firstSessionAt', now, {
      date: signUpDay,
      counters: { firstSessionGenerates: 1 },
    });
  } else if (after > FIRST_SESSION_MS && after <= RETURN_WINDOW_MS && !item.returnedAt) {
    events.returned = await markOnce(table, sub, 'returnedAt', now, {
      date: signUpDay,
      counters: { returnGenerates: 1 },
    });
  }
  return events;
}

/**
 * `image_downloaded`: marks the version downloaded the first time, and counts it, for generated images only
 * (versions with a `jobId`). Returns false when the version was already downloaded, isn't generated, or is gone.
 */
export async function recordDownload(
  { client, tableName }: MetricsTable,
  sub: string,
  imageId: string,
  version: number,
  now: Date,
): Promise<boolean> {
  try {
    await client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: tableName,
              Key: { PK: userPk(sub), SK: versionSk(imageId, version) },
              UpdateExpression: 'SET downloadedAt = :now',
              ConditionExpression:
                'attribute_exists(PK) AND attribute_exists(jobId) AND attribute_not_exists(downloadedAt)',
              ExpressionAttributeValues: { ':now': now.toISOString() },
            },
          },
          { Update: metricsCountsUpdate(tableName, utcDate(now), { imagesDownloaded: 1 }, now) },
        ],
      }),
    );
    return true;
  } catch (error) {
    if (
      error instanceof TransactionCanceledException &&
      error.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed'
    ) {
      return false;
    }
    throw error;
  }
}

/** The fields of a deleted version that decide whether it counts against the keep rate. */
export interface DeletedVersion {
  jobId?: string;
  createdAt?: string;
  downloadedAt?: string;
}

/**
 * Counts deleted generated versions that were never downloaded and are under 7 days old as `imagesDiscarded`,
 * on the day each was made. The daily job subtracts them from the day's images to get the images kept.
 */
export async function recordDiscarded(
  table: MetricsTable,
  versions: readonly DeletedVersion[],
  now: Date,
): Promise<number> {
  const byDay = new Map<string, number>();
  const oldest = now.getTime() - KEEP_WINDOW_DAYS * SECONDS_PER_DAY * 1000;
  for (const version of versions) {
    if (!version.jobId || !version.createdAt || version.downloadedAt) continue;
    const made = new Date(version.createdAt);
    if (Number.isNaN(made.getTime()) || made.getTime() < oldest) continue;
    const day = utcDate(made);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  for (const [day, discarded] of byDay) {
    await addMetricCounts(table, day, { imagesDiscarded: discarded }, now);
  }
  return [...byDay.values()].reduce((total, count) => total + count, 0);
}

/**
 * `first_image_shown`: stores a new account's time to first image on today's `METRICS#` partition and counts
 * it, once per user. Returns false for an account over a day old, or one already recorded.
 */
export async function recordFirstImageShown(
  table: MetricsTable,
  sub: string,
  ms: number,
  now: Date,
): Promise<boolean> {
  const profile = await table.client.send(
    new GetCommand({
      TableName: table.tableName,
      Key: { PK: userPk(sub), SK: PROFILE_SK },
      ProjectionExpression: 'createdAt, firstImageShownAt',
    }),
  );
  const item = profile.Item as { createdAt?: string; firstImageShownAt?: string } | undefined;
  if (!item?.createdAt || item.firstImageShownAt) return false;
  if (now.getTime() - new Date(item.createdAt).getTime() > TTFI_ACCOUNT_AGE_MS) return false;
  const date = utcDate(now);
  return markOnce(
    table,
    sub,
    'firstImageShownAt',
    now,
    { date, counters: { firstImagesShown: 1 } },
    [
      {
        Put: {
          TableName: table.tableName,
          Item: {
            PK: metricsPk(date),
            SK: ttfiSk(sub),
            ms,
            ttl: ttlAfter(now, METRICS_TTL_DAYS * SECONDS_PER_DAY),
          },
        },
      },
    ],
  );
}
