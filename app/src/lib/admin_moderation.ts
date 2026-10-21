import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import {
  MODLOG_TTL_DAYS,
  SECONDS_PER_DAY,
  STATS_MODERATION_SK,
  STATS_TTL_DAYS,
  adminModerationQuerySchema,
  modlogPk,
  reviewRequestSchema,
  statsPk,
  thumbnailKey,
  ttlAfter,
  utcDate,
  utcDateSchema,
  type ModlogItem,
  type ReviewVerdict,
} from '@pictora/core';
import { adminRefusal } from './admin';
import type { AdminDeps } from './admin_stats';
import { apiError, type ApiResult } from './jobs';
import type { Session } from './session';

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** A block or report as the review queue shows it (ADM-4). */
export interface ModerationEntry {
  id: string;
  date: string;
  type: 'block' | 'report';
  userId: string;
  createdAt: string;
  promptExcerpt: string;
  /** Blocks: where and why. */
  stage?: string;
  category?: string;
  provider?: string;
  jobId?: string;
  uploadId?: string;
  /** Reports: why, and the image version reported, with its thumbnail. */
  reason?: string;
  imageId?: string;
  version?: number;
  thumbUrl?: string;
  modelId?: string;
  review?: ReviewVerdict;
  reviewedBy?: string;
  reviewedAt?: string;
}

/** The `GET /api/admin/moderation` body. */
export interface ModerationListBody {
  date: string;
  entries: ModerationEntry[];
}

type ReviewableItem = Extract<ModlogItem, { type: 'block' | 'report' }>;

/**
 * `GET /api/admin/moderation?date=` (ADM-4): the day's blocks and reports from `MODLOG#<date>`, newest first,
 * with a presigned thumbnail for each reported image. Admin actions logged that day are left out.
 */
export async function listModeration(
  deps: AdminDeps,
  session: Session,
  query: Record<string, string>,
): Promise<ApiResult> {
  const refusal = adminRefusal(session);
  if (refusal) return refusal;
  const parsed = adminModerationQuerySchema.safeParse(query);
  if (!parsed.success) return apiError('invalid_request', 'Use a date like 2026-10-15.');
  const date = parsed.data.date ?? utcDate(deps.now());

  const items: ReviewableItem[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await deps.client.send(
      new QueryCommand({
        TableName: deps.tableName,
        KeyConditionExpression: 'PK = :pk',
        FilterExpression: '#type IN (:block, :report)',
        ExpressionAttributeNames: { '#type': 'type' },
        ExpressionAttributeValues: {
          ':pk': modlogPk(date),
          ':block': 'block',
          ':report': 'report',
        },
        ScanIndexForward: false,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    items.push(...((page.Items ?? []) as ReviewableItem[]));
    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey);

  const entries = await Promise.all(items.map((item) => moderationEntry(deps, date, item)));
  const body: ModerationListBody = { date, entries };
  return { status: 200, body: { ...body } };
}

async function moderationEntry(
  deps: AdminDeps,
  date: string,
  item: ReviewableItem,
): Promise<ModerationEntry> {
  const entry: ModerationEntry = {
    id: item.SK,
    date,
    type: item.type,
    userId: item.userId,
    createdAt: item.createdAt,
    promptExcerpt: item.promptExcerpt,
    ...(item.modelId ? { modelId: item.modelId } : {}),
    ...(item.review ? { review: item.review } : {}),
    ...(item.reviewedBy ? { reviewedBy: item.reviewedBy } : {}),
    ...(item.reviewedAt ? { reviewedAt: item.reviewedAt } : {}),
  };
  if (item.type === 'block') {
    return {
      ...entry,
      stage: item.stage,
      category: item.category,
      ...(item.provider ? { provider: item.provider } : {}),
      ...(item.jobId ? { jobId: item.jobId } : {}),
      ...(item.uploadId ? { uploadId: item.uploadId } : {}),
    };
  }
  // Only the reporting user's own objects are presigned.
  const thumbUrl = item.s3Key.startsWith(`users/${item.userId}/`)
    ? await deps.presign(thumbnailKey(item.userId, item.imageId, item.version))
    : undefined;
  return {
    ...entry,
    reason: item.reason,
    imageId: item.imageId,
    version: item.version,
    ...(thumbUrl ? { thumbUrl } : {}),
  };
}

/**
 * `POST /api/admin/moderation/:date/:id/review` (ADM-4): marks a block or report `ok` or `confirmed`. In one
 * transaction it records the verdict on the entry, counts it on `STATS#<date>` / `MODERATION` (an `ok` block
 * is a false block, for the PRD's metric), and logs an `admin_action` entry with the admin's `sub`. Changing a
 * verdict moves the counts; the condition on the previous verdict keeps two admins from counting twice.
 */
export async function reviewEntry(
  deps: AdminDeps,
  session: Session,
  date: string,
  id: string,
  input: unknown,
): Promise<ApiResult> {
  const refusal = adminRefusal(session);
  if (refusal) return refusal;
  const notFound = apiError('not_found', 'Moderation entry not found.');
  if (!utcDateSchema.safeParse(date).success || !ULID_PATTERN.test(id)) return notFound;
  const parsed = reviewRequestSchema.safeParse(input);
  if (!parsed.success) return apiError('invalid_request', 'Pick ok or confirmed.');
  const { verdict } = parsed.data;

  const key = { PK: modlogPk(date), SK: id };
  const found = (
    await deps.client.send(
      new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }),
    )
  ).Item as ModlogItem | undefined;
  if (!found || found.type === 'admin_action') return notFound;
  const previous = found.review;
  if (previous === verdict) return { status: 200, body: { id, date, review: verdict } };

  const now = deps.now();
  const at = now.toISOString();
  const counters = reviewCounters(found.type, previous, verdict);
  const names: Record<string, string> = { '#ttl': 'ttl' };
  const values: Record<string, number> = {
    ':ttl': ttlAfter(now, STATS_TTL_DAYS * SECONDS_PER_DAY),
  };
  const adds = Object.entries(counters).map(([name, value], index) => {
    names[`#c${index}`] = name;
    values[`:c${index}`] = value;
    return `#c${index} :c${index}`;
  });
  const log: ModlogItem = {
    PK: modlogPk(utcDate(now)),
    SK: deps.newId(),
    type: 'admin_action',
    action: 'review',
    userId: session.sub,
    targetUserId: found.userId,
    entryDate: date,
    entryId: id,
    verdict,
    createdAt: at,
    ttl: ttlAfter(now, MODLOG_TTL_DAYS * SECONDS_PER_DAY),
  };
  try {
    await deps.client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: deps.tableName,
              Key: key,
              UpdateExpression: 'SET review = :verdict, reviewedBy = :admin, reviewedAt = :now',
              ConditionExpression: previous
                ? 'review = :previous'
                : 'attribute_exists(PK) AND attribute_not_exists(review)',
              ExpressionAttributeValues: {
                ':verdict': verdict,
                ':admin': session.sub,
                ':now': at,
                ...(previous ? { ':previous': previous } : {}),
              },
            },
          },
          ...(adds.length > 0
            ? [
                {
                  Update: {
                    TableName: deps.tableName,
                    Key: { PK: statsPk(date), SK: STATS_MODERATION_SK },
                    UpdateExpression: `ADD ${adds.join(', ')} SET #ttl = if_not_exists(#ttl, :ttl)`,
                    ExpressionAttributeNames: names,
                    ExpressionAttributeValues: values,
                  },
                },
              ]
            : []),
          { Put: { TableName: deps.tableName, Item: log } },
        ],
      }),
    );
  } catch (error) {
    if (
      error instanceof TransactionCanceledException &&
      error.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed'
    ) {
      return apiError(
        'invalid_state',
        'Another admin reviewed this entry at the same time. Reload the list and try again.',
      );
    }
    throw error;
  }
  return { status: 200, body: { id, date, review: verdict } };
}

/**
 * How a review moves the counts on `STATS#<date>` / `MODERATION`: a first review counts the entry as reviewed,
 * and an `ok` on a block counts a false block. Changing a verdict only moves the false-block count.
 */
export function reviewCounters(
  type: 'block' | 'report',
  previous: ReviewVerdict | undefined,
  verdict: ReviewVerdict,
): Record<string, number> {
  if (type === 'report') return previous ? {} : { reportsReviewed: 1 };
  const counters: Record<string, number> = {};
  if (!previous) counters.blocksReviewed = 1;
  const falseBlocks = (verdict === 'ok' ? 1 : 0) - (previous === 'ok' ? 1 : 0);
  if (falseBlocks !== 0) counters.falseBlocks = falseBlocks;
  return counters;
}
