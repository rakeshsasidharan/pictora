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
  BLOCK_TTL_SECONDS,
  JOB_SK,
  MODLOG_TTL_DAYS,
  PLATFORM_PK,
  PROFILE_SK,
  SECONDS_PER_DAY,
  STATS_TTL_DAYS,
  activeJobsGsiPk,
  blockSk,
  isBatchJob,
  imageSk,
  jobPk,
  modlogPk,
  promptExcerpt,
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
  type BlockItem,
  type Aspect,
  type BlockStage,
  type EditJobRequest,
  type GenerateJobRequest,
  type JobError,
  type JobImage,
  type JobItem,
  type ModlogItem,
  type PointsSettlement,
} from '@pictora/core';
import { metricsCountsUpdate } from '@pictora/core/metrics-store';
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

/** Where a finishing transaction holds the concurrency slot release, or a batch job's profile check. */
const SLOT_ITEM_INDEX = 2;

/**
 * A batch job's account was deleted (or is being deleted) before the job finished, so nothing may be written
 * under the user any more (tech design 5.4). The caller drops the job with `dropJob`.
 */
export class AccountGoneError extends Error {
  constructor(readonly jobId: string) {
    super(`The account of batch job ${jobId} is gone`);
    this.name = 'AccountGoneError';
  }
}

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
  /** The running job, as `claimJob` returned it, or a submitted batch job as the poller read it. */
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
 * nothing, when the job is no longer in the status it was read in (the sweeper failed it). A batch job holds
 * no slot; its account is checked instead, and `AccountGoneError` is thrown when it is gone.
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
          transparentBackground: request.transparentBackground,
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
        ConditionExpression: '#status = :from AND GSI1SK = :since',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':succeeded': 'succeeded',
          ':from': job.status,
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
    {
      Update: metricsCountsUpdate(
        ctx.tableName,
        utcDate(now),
        { jobsSucceeded: 1, imagesGenerated: images.length },
        now,
      ),
    },
    ...imageItems,
  ]);
}

/** The fields of a `VER#<imageId>#<n>` item an edit starts from. */
export interface SourceVersion {
  imageId: string;
  version: number;
  s3Key: string;
  width: number;
  height: number;
  aspect?: Aspect;
}

/** A version of one of the user's images, or undefined when the image or the version doesn't exist. */
export async function loadVersion(
  { client, tableName }: TableContext,
  sub: string,
  imageId: string,
  version: number,
): Promise<SourceVersion | undefined> {
  const result = await client.send(
    new GetCommand({
      TableName: tableName,
      Key: { PK: userPk(sub), SK: versionSk(imageId, version) },
      ConsistentRead: true,
    }),
  );
  return result.Item as SourceVersion | undefined;
}

/**
 * Claims the next version number of an image for an edit's result (EDIT-3), with a counter on the `IMG#` item
 * that starts from `latestVersion`. Each claim gets its own number, so concurrent edits never write the same
 * `v<n>.png`; a claim whose job then fails leaves a gap in the numbers. Undefined when the image is gone.
 */
export async function claimVersion(
  { client, tableName }: TableContext,
  sub: string,
  imageId: string,
): Promise<number | undefined> {
  try {
    const result = await client.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { PK: userPk(sub), SK: imageSk(imageId) },
        UpdateExpression:
          'SET versionsClaimed = if_not_exists(versionsClaimed, latestVersion) + :one',
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeValues: { ':one': 1 },
        ReturnValues: 'UPDATED_NEW',
      }),
    );
    const claimed = result.Attributes?.versionsClaimed;
    return typeof claimed === 'number' ? claimed : undefined;
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) return undefined;
    throw error;
  }
}

export interface CompleteEditInput {
  /** The running job, as `claimJob` returned it. */
  job: JobItem;
  request: EditJobRequest;
  /** The new version, stored in S3 under the number `claimVersion` gave it. */
  image: StoredImage & { version: number };
  /** The aspect the provider was asked for, nearest the parent's shape. */
  aspect: Aspect;
  settlement: PointsSettlement;
  providerCostCents: number;
  now: Date;
}

/** How recording an edit ended: recorded, the job swept first, or the image deleted while the job ran. */
export type EditCompletion = 'completed' | 'swept' | 'image_gone';

/**
 * Records a succeeded edit in one transaction (tech design 5.3): the new `VER#<imageId>#<n>` item with its parent
 * and instruction, the image's `versionCount` and (unless a later-numbered edit finished first) `latestVersion`
 * and thumbnail, and the job, points, slot, spend and stats as for a generate job. Earlier versions are never
 * touched (EDIT-3).
 */
export async function completeEditJob(
  ctx: TableContext,
  input: CompleteEditInput,
): Promise<EditCompletion> {
  const { job, request, image, settlement, providerCostCents, now } = input;
  const at = now.toISOString();
  const pk = userPk(job.userId);
  const jobImages: JobImage[] = [
    { imageId: image.imageId, version: image.version, s3Key: image.s3Key },
  ];
  const common: TransactItem[] = [
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
      images: 1,
      points: settlement.chargedPoints,
      providerCostCents,
    }),
    {
      Update: metricsCountsUpdate(
        ctx.tableName,
        utcDate(now),
        { jobsSucceeded: 1, imagesGenerated: 1 },
        now,
      ),
    },
    {
      Put: {
        TableName: ctx.tableName,
        Item: {
          PK: pk,
          SK: versionSk(image.imageId, image.version),
          imageId: image.imageId,
          version: image.version,
          s3Key: image.s3Key,
          thumbKey: image.thumbKey,
          width: image.width,
          height: image.height,
          parentVersion: request.parentVersion,
          editInstruction: request.instruction,
          modelId: job.modelId,
          quality: request.quality,
          aspect: input.aspect,
          ...(request.referenceKeys?.length
            ? { referenceCount: request.referenceKeys.length }
            : {}),
          jobId: job.jobId,
          costPoints: image.costPoints,
          createdAt: at,
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      },
    },
  ];
  const imageKeyAttrs = { PK: pk, SK: imageSk(image.imageId) };
  const asLatest: TransactItem = {
    Update: {
      TableName: ctx.tableName,
      Key: imageKeyAttrs,
      UpdateExpression: 'ADD versionCount :one SET latestVersion = :n, thumbKey = :thumb',
      ConditionExpression: 'attribute_exists(PK) AND latestVersion < :n',
      ExpressionAttributeValues: { ':one': 1, ':n': image.version, ':thumb': image.thumbKey },
    },
  };
  // A later-numbered edit of the same image finished first: count this version without making it the latest.
  const asEarlier: TransactItem = {
    Update: {
      TableName: ctx.tableName,
      Key: imageKeyAttrs,
      UpdateExpression: 'ADD versionCount :one',
      ConditionExpression: 'attribute_exists(PK)',
      ExpressionAttributeValues: { ':one': 1 },
    },
  };

  for (const imageUpdate of [asLatest, asEarlier]) {
    try {
      await ctx.client.send(new TransactWriteCommand({ TransactItems: [...common, imageUpdate] }));
    } catch (error) {
      if (!(error instanceof TransactionCanceledException)) throw error;
      const codes = (error.CancellationReasons ?? []).map((reason) => reason.Code);
      if (codes[0] === 'ConditionalCheckFailed') return 'swept';
      if (codes[common.length] === 'ConditionalCheckFailed') {
        if (imageUpdate === asLatest) continue;
        return 'image_gone';
      }
      throw error;
    }
    await syncUsageRank(ctx, job.userId, job.usageDate);
    return 'completed';
  }
  return 'image_gone';
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
  /** For a block: the `BLOCK#` and `MODLOG#` items to write with it. */
  block?: BlockRecord;
  now: Date;
}

/** Why a job was blocked, recorded as a `BLOCK#` item and a `MODLOG#` entry (tech design 6.3). */
export interface BlockRecord {
  /** A ULID, used as the key of both items. */
  blockId: string;
  stage: BlockStage;
  category: string;
  /** The prompt that was checked; only an excerpt is kept. */
  prompt: string;
}

/**
 * Fails or blocks an active job with a full refund, in one transaction (tech design 4.1): the final status and
 * error, every reserved point back on the day they came from, one concurrency slot freed, the day's failure
 * or block count, and for a block its `BLOCK#` item and `MODLOG#` entry. Returns false, writing nothing, when
 * the job has left the status it was read in.
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
    {
      Update: metricsCountsUpdate(
        ctx.tableName,
        utcDate(now),
        { [status === 'blocked' ? 'jobsBlocked' : 'jobsFailed']: 1 },
        now,
      ),
    },
    ...(cost > 0 ? [spendUpdate(ctx.tableName, now, cost)] : []),
    ...(input.block ? blockItems(ctx.tableName, job, input.block, now) : []),
  ]);
}

/** The `BLOCK#` item (24 h) and the `MODLOG#` entry (90 days) for a blocked job. */
function blockItems(
  tableName: string,
  job: JobItem,
  block: BlockRecord,
  now: Date,
): TransactItem[] {
  const at = now.toISOString();
  const blockItem: BlockItem = {
    PK: userPk(job.userId),
    SK: blockSk(block.blockId),
    stage: block.stage,
    category: block.category,
    jobId: job.jobId,
    createdAt: at,
    ttl: ttlAfter(now, BLOCK_TTL_SECONDS),
  };
  const logItem: ModlogItem = {
    PK: modlogPk(utcDate(now)),
    SK: block.blockId,
    type: 'block',
    userId: job.userId,
    stage: block.stage,
    category: block.category,
    promptExcerpt: promptExcerpt(block.prompt),
    provider: job.provider,
    modelId: job.modelId,
    jobId: job.jobId,
    createdAt: at,
    ttl: ttlAfter(now, MODLOG_TTL_DAYS * SECONDS_PER_DAY),
  };
  return [
    { Put: { TableName: tableName, Item: blockItem } },
    { Put: { TableName: tableName, Item: logItem } },
  ];
}

type TransactItem = NonNullable<
  ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']
>[number];

/**
 * Runs a finishing transaction whose first item is the job's guarded update, and whose third is the slot release
 * or, for a batch job, the account check.
 */
async function finishTransaction(
  ctx: TableContext,
  job: JobItem,
  items: TransactItem[],
): Promise<boolean> {
  try {
    await ctx.client.send(new TransactWriteCommand({ TransactItems: items }));
  } catch (error) {
    if (error instanceof TransactionCanceledException) {
      const codes = (error.CancellationReasons ?? []).map((reason) => reason.Code);
      if (codes[0] === 'ConditionalCheckFailed') return false;
      if (codes[SLOT_ITEM_INDEX] === 'ConditionalCheckFailed' && isBatchJob(job)) {
        throw new AccountGoneError(job.jobId);
      }
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

/**
 * Frees the job's concurrency slot (LIM-3). A batch job never took one; instead the transaction checks its
 * account still exists and isn't being deleted, so a batch finishing after a purge writes nothing back.
 */
function slotRelease(tableName: string, job: JobItem): TransactItem {
  if (isBatchJob(job)) {
    return {
      ConditionCheck: {
        TableName: tableName,
        Key: { PK: userPk(job.userId), SK: PROFILE_SK },
        ConditionExpression: 'attribute_exists(PK) AND #status <> :deleting',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':deleting': 'deleting' },
      },
    };
  }
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

/**
 * Puts a scheduled batch job in a provider batch (tech design 5.4): `scheduled → submitted`, with `submittedAt`,
 * one more attempt, and the job on the submitted index. Undefined when the job was no longer scheduled. The
 * claim comes before the provider call, so a job is never sent in two batches.
 */
export async function claimBatchJob(
  { client, tableName }: TableContext,
  job: JobItem,
  now: Date,
): Promise<JobItem | undefined> {
  try {
    const result = await client.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { PK: jobPk(job.jobId), SK: JOB_SK },
        UpdateExpression:
          'SET #status = :submitted, submittedAt = :now, GSI1PK = :index, GSI1SK = :now ADD attempts :one',
        ConditionExpression: '#status = :scheduled AND GSI1SK = :since',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':submitted': 'submitted',
          ':scheduled': 'scheduled',
          ':since': job.GSI1SK,
          ':now': now.toISOString(),
          ':index': activeJobsGsiPk('submitted'),
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

/** Records the provider's batch ID on a submitted job. False when the job has moved on since. */
export async function setBatchId(
  { client, tableName }: TableContext,
  job: JobItem,
  batchId: string,
): Promise<boolean> {
  try {
    await client.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { PK: jobPk(job.jobId), SK: JOB_SK },
        UpdateExpression: 'SET batchId = :batchId',
        ConditionExpression: '#status = :submitted AND GSI1SK = :since',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':batchId': batchId,
          ':submitted': 'submitted',
          ':since': job.GSI1SK,
        },
      }),
    );
    return true;
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) return false;
    throw error;
  }
}

/**
 * Fails a batch job whose account is gone, touching nothing but the job item (tech design 5.4): there is no
 * one left to refund. False when the job has left the status it was read in.
 */
export async function dropJob(
  { client, tableName }: TableContext,
  job: JobItem,
  error: JobError,
  now: Date,
): Promise<boolean> {
  try {
    await client.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { PK: jobPk(job.jobId), SK: JOB_SK },
        UpdateExpression:
          'SET #status = :failed, #error = :error, finishedAt = :now, pointsCharged = :zero' +
          ' REMOVE GSI1PK, GSI1SK',
        ConditionExpression: '#status = :from AND GSI1SK = :since',
        ExpressionAttributeNames: { '#status': 'status', '#error': 'error' },
        ExpressionAttributeValues: {
          ':failed': 'failed',
          ':error': error,
          ':now': now.toISOString(),
          ':zero': 0,
          ':from': job.status,
          ':since': job.GSI1SK,
        },
      }),
    );
    return true;
  } catch (caught) {
    if (caught instanceof ConditionalCheckFailedException) return false;
    throw caught;
  }
}
