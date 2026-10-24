import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import {
  JOB_SK,
  MAX_ACTIVE_JOBS,
  PROFILE_SK,
  RATE_TTL_SECONDS,
  SECONDS_PER_DAY,
  USAGE_TTL_DAYS,
  isBatchJob,
  jobPk,
  rateSk,
  ttlAfter,
  usageSk,
  userPk,
  utcMinute,
  type JobError,
  type JobItem,
} from '@pictora/core';

/** Why a reservation was refused, in the order they're reported when several apply. */
export type ReserveFailure = 'profile' | 'rate' | 'points';

export type ReserveResult = { ok: true } | { ok: false; reason: ReserveFailure };

/** Concurrent transactions on the same items are cancelled with `TransactionConflict`; they're retried. */
const MAX_RESERVE_ATTEMPTS = 4;

export interface ReserveInput {
  job: JobItem;
  /** The user's daily allowance in points. */
  limit: number;
  /** The user's per-minute request limit (`rateLimitPerMinute`). */
  rateLimit: number;
  now: Date;
}

/**
 * Reserves points and a concurrency slot and records the job, in one `TransactWriteItems` call (tech design
 * 4.1): the minute's rate counter (below `rateLimit`), the day's usage (staying within the limit), the profile
 * (active, no cooldown, fewer than 2 running jobs) and the queued job. Either all of it happens or none. A batch
 * job (tech design 5.4) takes no slot, so its profile is only checked.
 */
export async function reserveJob(
  client: DynamoDBDocumentClient,
  tableName: string,
  { job, limit, rateLimit, now }: ReserveInput,
): Promise<ReserveResult> {
  const pk = userPk(job.userId);
  const points = job.pointsReserved;
  const command = new TransactWriteCommand({
    TransactItems: [
      {
        Update: {
          TableName: tableName,
          Key: { PK: pk, SK: rateSk(utcMinute(now)) },
          UpdateExpression: 'ADD #count :one SET #ttl = :ttl',
          ConditionExpression: 'attribute_not_exists(#count) OR #count < :max',
          ExpressionAttributeNames: { '#count': 'count', '#ttl': 'ttl' },
          ExpressionAttributeValues: {
            ':one': 1,
            ':max': rateLimit,
            ':ttl': ttlAfter(now, RATE_TTL_SECONDS),
          },
        },
      },
      {
        Update: {
          TableName: tableName,
          Key: { PK: pk, SK: usageSk(job.usageDate) },
          UpdateExpression: 'ADD #used :points SET GSI1PK = :gsi, #ttl = :ttl',
          ConditionExpression: 'attribute_not_exists(#used) OR #used <= :maxUsed',
          ExpressionAttributeNames: { '#used': 'used', '#ttl': 'ttl' },
          ExpressionAttributeValues: {
            ':points': points,
            ':maxUsed': limit - points,
            ':gsi': `USAGE#${job.usageDate}`,
            ':ttl': ttlAfter(now, USAGE_TTL_DAYS * SECONDS_PER_DAY),
          },
        },
      },
      isBatchJob(job)
        ? {
            // A batch job takes no concurrency slot (tech design 5.4), but the account must still be able to
            // start jobs.
            ConditionCheck: {
              TableName: tableName,
              Key: { PK: pk, SK: PROFILE_SK },
              ConditionExpression:
                'attribute_exists(PK) AND #status = :active' +
                ' AND (attribute_not_exists(cooldownUntil) OR cooldownUntil <= :now)',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: { ':active': 'active', ':now': now.toISOString() },
            },
          }
        : {
            Update: {
              TableName: tableName,
              Key: { PK: pk, SK: PROFILE_SK },
              UpdateExpression: 'ADD activeJobs :one',
              ConditionExpression:
                'attribute_exists(PK) AND #status = :active' +
                ' AND (attribute_not_exists(activeJobs) OR activeJobs < :maxActive)' +
                ' AND (attribute_not_exists(cooldownUntil) OR cooldownUntil <= :now)',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: {
                ':one': 1,
                ':active': 'active',
                ':maxActive': MAX_ACTIVE_JOBS,
                ':now': now.toISOString(),
              },
            },
          },
      {
        Put: {
          TableName: tableName,
          Item: job,
          ConditionExpression: 'attribute_not_exists(PK)',
        },
      },
    ],
  });

  for (let attempt = 1; ; attempt++) {
    try {
      await client.send(command);
      return { ok: true };
    } catch (error) {
      if (!(error instanceof TransactionCanceledException)) throw error;
      const codes = (error.CancellationReasons ?? []).map((reason) => reason.Code);
      const failed = (index: number) => codes[index] === 'ConditionalCheckFailed';
      if (failed(2)) return { ok: false, reason: 'profile' };
      if (failed(0)) return { ok: false, reason: 'rate' };
      if (failed(1)) return { ok: false, reason: 'points' };
      if (!codes.includes('TransactionConflict') || attempt >= MAX_RESERVE_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * attempt + Math.random() * 30));
    }
  }
}

/**
 * Fails a queued job and gives back what it reserved, in one transaction (tech design 4.1): the job's final
 * status and error, the day's points, and the concurrency slot. Does nothing if the job already left `queued`.
 */
export async function failQueuedJob(
  client: DynamoDBDocumentClient,
  tableName: string,
  job: Pick<JobItem, 'jobId' | 'userId' | 'usageDate' | 'pointsReserved'>,
  error: JobError,
  now: Date,
): Promise<void> {
  const pk = userPk(job.userId);
  await client.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: tableName,
            Key: { PK: jobPk(job.jobId), SK: JOB_SK },
            UpdateExpression:
              'SET #status = :failed, #error = :error, finishedAt = :now, pointsCharged = :zero' +
              ' REMOVE GSI1PK, GSI1SK',
            ConditionExpression: '#status = :queued',
            ExpressionAttributeNames: { '#status': 'status', '#error': 'error' },
            ExpressionAttributeValues: {
              ':failed': 'failed',
              ':queued': 'queued',
              ':error': error,
              ':now': now.toISOString(),
              ':zero': 0,
            },
          },
        },
        {
          Update: {
            TableName: tableName,
            Key: { PK: pk, SK: usageSk(job.usageDate) },
            UpdateExpression: 'ADD #used :refund',
            ExpressionAttributeNames: { '#used': 'used' },
            ExpressionAttributeValues: { ':refund': -job.pointsReserved },
          },
        },
        {
          Update: {
            TableName: tableName,
            Key: { PK: pk, SK: PROFILE_SK },
            UpdateExpression: 'ADD activeJobs :minusOne',
            ExpressionAttributeValues: { ':minusOne': -1 },
          },
        },
      ],
    }),
  );
}

export async function readJob(
  client: DynamoDBDocumentClient,
  tableName: string,
  jobId: string,
): Promise<JobItem | undefined> {
  const result = await client.send(
    new GetCommand({ TableName: tableName, Key: { PK: jobPk(jobId), SK: JOB_SK } }),
  );
  return result.Item as JobItem | undefined;
}

/** Points used (reserved plus spent) on a UTC day. */
export async function readUsedPoints(
  client: DynamoDBDocumentClient,
  tableName: string,
  sub: string,
  date: string,
): Promise<number> {
  const result = await client.send(
    new GetCommand({
      TableName: tableName,
      Key: { PK: userPk(sub), SK: usageSk(date) },
      ConsistentRead: true,
    }),
  );
  const used = result.Item?.used;
  return typeof used === 'number' ? Math.max(0, used) : 0;
}
