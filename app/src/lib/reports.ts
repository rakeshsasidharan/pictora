import { GetCommand, PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  MODLOG_TTL_DAYS,
  SECONDS_PER_DAY,
  modlogPk,
  promptExcerpt,
  rateLimitPerMinute,
  reportRequestSchema,
  ttlAfter,
  userPk,
  utcDate,
  versionSk,
  type ModlogItem,
} from '@pictora/core';
import { takeRateSlot } from './enhance';
import { apiError, type ApiResult } from './jobs';
import type { Session } from './session';

/** What the report API needs, so tests can swap the table, the clock and the IDs. */
export interface ReportsDeps {
  client: DynamoDBDocumentClient;
  tableName: string;
  now: () => Date;
  newId: () => string;
}

/** The version item fields a report copies, so reviewers see what was reported. */
interface VersionItem {
  s3Key: string;
  prompt?: string;
  editInstruction?: string;
  /** An uploaded image has no model. */
  modelId?: string;
}

/**
 * `POST /api/reports` (PRD, Trust and safety): a user reports one of their own image versions. Writes a
 * `MODLOG#<date>` entry of type `report`, kept 90 days for review. Answers 404 for a version the user doesn't
 * own, the same as for one that doesn't exist. Reports count in the minute's rate window with jobs (429), so a
 * script can't flood the review queue.
 */
export async function createReport(
  deps: ReportsDeps,
  session: Session,
  input: unknown,
): Promise<ApiResult> {
  const parsed = reportRequestSchema.safeParse(input);
  if (!parsed.success) {
    return apiError('invalid_request', 'Pick a reason for the report, then try again.');
  }
  const { imageId, version, reason } = parsed.data;
  const now = deps.now();
  const rateLimit = rateLimitPerMinute(session.groups);
  if (!(await takeRateSlot(deps.client, deps.tableName, session.sub, now, rateLimit))) {
    return apiError(
      'rate_limited',
      `You've made ${rateLimit} requests in the last minute. Wait a moment, then try again.`,
    );
  }
  const result = await deps.client.send(
    new GetCommand({
      TableName: deps.tableName,
      Key: { PK: userPk(session.sub), SK: versionSk(imageId, version) },
    }),
  );
  const found = result.Item as VersionItem | undefined;
  if (!found) return apiError('not_found', 'Image not found.');

  const reportId = deps.newId();
  const entry: ModlogItem = {
    PK: modlogPk(utcDate(now)),
    SK: reportId,
    type: 'report',
    userId: session.sub,
    reason,
    imageId,
    version,
    s3Key: found.s3Key,
    promptExcerpt: promptExcerpt(found.editInstruction ?? found.prompt ?? ''),
    modelId: found.modelId,
    createdAt: now.toISOString(),
    ttl: ttlAfter(now, MODLOG_TTL_DAYS * SECONDS_PER_DAY),
  };
  await deps.client.send(
    new PutCommand({
      TableName: deps.tableName,
      Item: entry,
      ConditionExpression: 'attribute_not_exists(PK)',
    }),
  );
  return { status: 201, body: { reportId } };
}
