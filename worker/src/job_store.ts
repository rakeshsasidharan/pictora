import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import {
  JOB_SK,
  PLATFORM_PK,
  PROFILE_SK,
  SECONDS_PER_DAY,
  STATS_TTL_DAYS,
  activeJobsGsiPk,
  imageSk,
  jobPk,
  spendSk,
  statsModelSk,
  statsPk,
  ttlAfter,
  usageRankSk,
  usageSk,
  userPk,
  utcDate,
  utcMonth,
  versionSk,
  type ActiveJobStatus,
  type GenerateJobRequest,
  type JobError,
  type JobImage,
  type JobItem,
  type PointsSettlement,
} from '@pictora/core';
import { log } from './log.js';

/** The single table and a client for it. */
export interface TableContext {
  client: DynamoDBDocumentClient;
  tableName: string;
}

/** The index stuck jobs are found through: active jobs carry `GSI1PK = JOBS#<status>`, `GSI1SK = <since>`. */
const GSI1 = 'GSI1';

/** Attempts at writing a usage item's rank before leaving it to the next settle. */
const MAX_RANK_ATTEMPTS = 3;

export async function loadJob(
  { client, tableName }: TableContext,
  jobId: string,
): Promise<JobItem | undefined> {
  const result = await client.send(
    new GetCommand({
      TableName: tableName,
      Key: { PK: jobPk(jobId), SK: JOB_SK },
      ConsistentRead: true,
    }),
  );
  return result.Item as JobItem | undefined;
}

/**
 * Moves a job `queued → running` (tech design 5.2), with `startedAt`, one more attempt, and the job on the running
 * index. Returns the running job, or undefined when it was no longer queued: claimed by another delivery of the
 * same message, finished, or swept. That condition is what keeps a job from reaching the provider twice.
 */
export async function claimJob(
  { client, tableName }: TableContext,
  jobId: string,
  now: Date,
): Promise<JobItem | undefined> {
  try {
    const result = await client.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { PK: jobPk(jobId), SK: JOB_SK },
        UpdateExpression:
          'SET #status = :running, startedAt = :now, GSI1PK = :index, GSI1SK = :now ADD attempts :one',
        ConditionExpression: 'attribute_exists(PK) AND #status = :queued',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':running': 'running',
          ':queued': 'queued',
          ':now': now.toISOString(),
          ':index': activeJobsGsiPk('running'),
          ':one': 1,
        },
        ReturnValues: 'ALL_NEW',
      }),
    );
    return result.Attributes as JobItem;
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) return undefined;
    throw error;
  }
}

/** One image of a succeeded job, stored in S3 as version 1. */
export interface StoredImage {
  imageId: string;
  s3Key: string;
  thumbKey: string;
  width: number;
  height: number;
  seed?: number;
  /** This image's share of the points charged. */
  costPoints: number;
}

export interface CompleteInput {
  /** The running job, as `claimJob` returned it. */
  job: JobItem;
  request: GenerateJobRequest;
  images: StoredImage[];
  settlement: PointsSettlement;
  providerCostCents: number;
  /** The prompt the provider was sent, with the style text. */
  sentPrompt: string;
  title: string;
  now: Date;
}

/**
 * Records a succeeded job in one transaction (tech design 5.1): the `IMG#` and `VER#…#1` items, the job as
 * `succeeded` with its images and charge, the settled points on the day they were reserved against, one
 * concurrency slot freed, and the month's platform spend and the day's model stats. Returns false, writing
 * nothing, when the job is no longer the running job this worker claimed (the sweeper failed it).
 */
export async function completeJob(ctx: TableContext, input: CompleteInput): Promise<boolean> {
  const { job, request, images, settlement, providerCostCents, now } = input;
  const at = now.toISOString();
  const pk = userPk(job.userId);
  const jobImages: JobImage[] = images.map(({ imageId, s3Key }) => ({
    imageId,
    version: 1,
    s3Key,
  }));

  const imageItems = images.flatMap((image) => [
    {
      Put: {
        TableName: ctx.tableName,
        Item: {
          PK: pk,
          SK: imageSk(image.imageId),
          imageId: image.imageId,
          title: input.title,
          latestVersion: 1,
          versionCount: 1,
          style: request.style,
          modelId: job.modelId,
          createdAt: at,
          thumbKey: image.thumbKey,
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      },
    },
    {
      Put: {
        TableName: ctx.tableName,
        Item: {
          PK: pk,
          SK: versionSk(image.imageId, 1),
          imageId: image.imageId,
          version: 1,
          s3Key: image.s3Key,
          thumbKey: image.thumbKey,
          width: image.width,
          height: image.height,
          prompt: request.prompt,
          enhancedPrompt: request.enhancedPrompt,
          avoid: request.avoid,
          sentPrompt: input.sentPrompt,
          style: request.style,
          modelId: job.modelId,
          quality: request.quality,
          aspect: request.aspect,
          seed: image.seed,
          jobId: job.jobId,
          costPoints: image.costPoints,
          createdAt: at,
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      },
    },
  ]);

  return finishTransaction(ctx, job, [
    {
      Update: {
        TableName: ctx.tableName,
        Key: { PK: jobPk(job.jobId), SK: JOB_SK },
        UpdateExpression:
          'SET #status = :succeeded, images = :images, pointsCharged = :charged,' +
          ' providerCostCents = :cost, finishedAt = :now REMOVE GSI1PK, GSI1SK',
        ConditionExpression: '#status = :running AND GSI1SK = :since',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':succeeded': 'succeeded',
          ':running': 'running',
          ':since': job.GSI1SK,
          ':images': jobImages,
          ':charged': settlement.chargedPoints,
          ':cost': providerCostCents,
          ':now': at,
        },
      },
    },
    usageUpdate(ctx.tableName, job, settlement.usageDelta),
    slotRelease(ctx.tableName, job),
    spendUpdate(ctx.tableName, now, providerCostCents),
    statsUpdate(ctx.tableName, job, now, {
      images: images.length,
      points: settlement.chargedPoints,
      providerCostCents,
    }),
    ...imageItems,
  ]);
}

export interface RefundInput {
  /** The job as last read: its `GSI1SK` says which claim (or queueing) this refund is for. */
  job: JobItem;
  /** The status the job must still be in. */
  from: ActiveJobStatus;
  status: 'failed' | 'blocked';
  error: JobError;
  /** What the provider already cost, when it answered before the job failed; counted as platform spend. */
  providerCostCents?: number;
  now: Date;
}

/**
 * Fails or blocks an active job with a full refund, in one transaction (tech design 4.1): the final status and
 * error, every reserved point back on the day they came from, one concurrency slot freed, and the day's
 * failure or block count. Returns false, writing nothing, when the job has left the status it was read in.
 */
export async function refundJob(ctx: TableContext, input: RefundInput): Promise<boolean> {
  const { job, from, status, error, now } = input;
  const cost = input.providerCostCents ?? 0;
  const at = now.toISOString();
  return finishTransaction(ctx, job, [
    {
      Update: {
        TableName: ctx.tableName,
        Key: { PK: jobPk(job.jobId), SK: JOB_SK },
        UpdateExpression:
          'SET #status = :final, #error = :error, finishedAt = :now, pointsCharged = :zero,' +
          ' providerCostCents = :cost REMOVE GSI1PK, GSI1SK',
        ConditionExpression: '#status = :from AND GSI1SK = :since',
        ExpressionAttributeNames: { '#status': 'status', '#error': 'error' },
        ExpressionAttributeValues: {
          ':final': status,
          ':from': from,
          ':since': job.GSI1SK,
          ':error': error,
          ':now': at,
          ':zero': 0,
          ':cost': cost,
        },
      },
    },
    usageUpdate(ctx.tableName, job, -job.pointsReserved),
    slotRelease(ctx.tableName, job),
    statsUpdate(ctx.tableName, job, now, {
      [status === 'blocked' ? 'blocks' : 'failures']: 1,
      ...(cost > 0 ? { providerCostCents: cost } : {}),
    }),
    ...(cost > 0 ? [spendUpdate(ctx.tableName, now, cost)] : []),
  ]);
}

type TransactItem = NonNullable<
  ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']
>[number];

/** Runs a finishing transaction whose first item is the job's guarded update. */
async function finishTransaction(
  ctx: TableContext,
  job: JobItem,
  items: TransactItem[],
): Promise<boolean> {
  try {
    await ctx.client.send(new TransactWriteCommand({ TransactItems: items }));
  } catch (error) {
    if (
      error instanceof TransactionCanceledException &&
      error.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed'
    ) {
      return false;
    }
    throw error;
  }
  await syncUsageRank(ctx, job.userId, job.usageDate);
  return true;
}

function usageUpdate(tableName: string, job: JobItem, delta: number): TransactItem {
  return {
    Update: {
      TableName: tableName,
      Key: { PK: userPk(job.userId), SK: usageSk(job.usageDate) },
      UpdateExpression: 'ADD #used :delta',
      ExpressionAttributeNames: { '#used': 'used' },
      ExpressionAttributeValues: { ':delta': delta },
    },
  };
}

function slotRelease(tableName: string, job: JobItem): TransactItem {
  return {
    Update: {
      TableName: tableName,
      Key: { PK: userPk(job.userId), SK: PROFILE_SK },
      UpdateExpression: 'ADD activeJobs :minusOne',
      ExpressionAttributeValues: { ':minusOne': -1 },
    },
  };
}

function spendUpdate(tableName: string, now: Date, cents: number): TransactItem {
  return {
    Update: {
      TableName: tableName,
      Key: { PK: PLATFORM_PK, SK: spendSk(utcMonth(now)) },
      UpdateExpression: 'ADD spentCents :cents',
      ExpressionAttributeValues: { ':cents': cents },
    },
  };
}

/** Adds counters to `STATS#<today>` / `MODEL#<modelId>`, which expires after 400 days. */
function statsUpdate(
  tableName: string,
  job: JobItem,
  now: Date,
  counters: Record<string, number>,
): TransactItem {
  const names: Record<string, string> = { '#ttl': 'ttl' };
  const values: Record<string, number> = {
    ':ttl': ttlAfter(now, STATS_TTL_DAYS * SECONDS_PER_DAY),
  };
  const adds = Object.entries(counters).map(([name, value], index) => {
    names[`#c${index}`] = name;
    values[`:c${index}`] = value;
    return `#c${index} :c${index}`;
  });
  return {
    Update: {
      TableName: tableName,
      Key: { PK: statsPk(utcDate(now)), SK: statsModelSk(job.modelId) },
      UpdateExpression: `ADD ${adds.join(', ')} SET #ttl = if_not_exists(#ttl, :ttl)`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    },
  };
}

/**
 * Sets a usage item's `GSI1SK` to its points used, zero-padded, so it ranks in the ADM-3 top-users query. A
 * transaction can't return the new total, so this reads it and writes it on condition it hasn't changed since.
 * Failures are logged, not thrown: the rank is a reporting index, and the next settle on the day rewrites it.
 */
export async function syncUsageRank(
  { client, tableName }: TableContext,
  sub: string,
  date: string,
): Promise<void> {
  const Key = { PK: userPk(sub), SK: usageSk(date) };
  try {
    for (let attempt = 1; attempt <= MAX_RANK_ATTEMPTS; attempt++) {
      const current = await client.send(
        new GetCommand({ TableName: tableName, Key, ConsistentRead: true }),
      );
      const used = current.Item?.used;
      if (typeof used !== 'number') return;
      try {
        await client.send(
          new UpdateCommand({
            TableName: tableName,
            Key,
            UpdateExpression: 'SET GSI1SK = :rank',
            ConditionExpression: '#used = :used',
            ExpressionAttributeNames: { '#used': 'used' },
            ExpressionAttributeValues: { ':rank': usageRankSk(used), ':used': used },
          }),
        );
        return;
      } catch (error) {
        if (!(error instanceof ConditionalCheckFailedException)) throw error;
      }
    }
  } catch (error) {
    log('WARN', 'Usage rank not updated', { date, error });
  }
}

/** Jobs that entered `status` before `cutoff`, oldest first, from the active-jobs index. */
export async function findStuckJobs(
  { client, tableName }: TableContext,
  status: ActiveJobStatus,
  cutoff: Date,
): Promise<JobItem[]> {
  const jobs: JobItem[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await client.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: GSI1,
        KeyConditionExpression: 'GSI1PK = :index AND GSI1SK < :cutoff',
        ExpressionAttributeValues: {
          ':index': activeJobsGsiPk(status),
          ':cutoff': cutoff.toISOString(),
        },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    jobs.push(...((page.Items ?? []) as JobItem[]));
    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return jobs;
}
