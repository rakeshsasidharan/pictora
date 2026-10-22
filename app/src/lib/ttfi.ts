import { rateLimitPerMinute, ttfiRequestSchema } from '@pictora/core';
import { recordFirstImageShown } from '@pictora/core/metrics-store';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { takeRateSlot } from './enhance';
import { apiError, type ApiResult } from './jobs';
import type { Session } from './session';

/** What the time-to-first-image API needs, so tests can swap the table and the clock. */
export interface TtfiDeps {
  client: DynamoDBDocumentClient;
  tableName: string;
  now: () => Date;
}

/**
 * `POST /api/metrics/ttfi` (tech design 11.1): `{ ms }`, the time from the browser's first page load to the
 * first image shown. Stored once per user, and only for an account at most a day old, so it measures a new user's
 * first visit; `recorded` says whether this call stored it. Counts in the minute's rate window (429).
 */
export async function recordTtfi(
  deps: TtfiDeps,
  session: Session,
  input: unknown,
): Promise<ApiResult> {
  const parsed = ttfiRequestSchema.safeParse(input);
  if (!parsed.success) {
    return apiError('invalid_request', 'Send ms, a whole number of milliseconds up to a day.');
  }
  const now = deps.now();
  const rateLimit = rateLimitPerMinute(session.groups);
  if (!(await takeRateSlot(deps.client, deps.tableName, session.sub, now, rateLimit))) {
    return apiError(
      'rate_limited',
      `You've made ${rateLimit} requests in the last minute. Wait a moment, then try again.`,
    );
  }
  const recorded = await recordFirstImageShown(deps, session.sub, parsed.data.ms, now);
  return { status: 200, body: { recorded } };
}
