import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import {
  MODLOG_TTL_DAYS,
  PROFILE_SK,
  SECONDS_PER_DAY,
  modlogPk,
  ttlAfter,
  userPk,
  userSubSchema,
  utcDate,
  type ModlogItem,
} from '@pictora/core';
import { adminRefusal } from './admin';
import type { AdminDeps } from './admin_stats';
import { readUsedPoints } from './job_store';
import { apiError, type ApiResult } from './jobs';
import { dailyLimit, type Profile } from './profile';
import type { Session } from './session';

/** The `GET /api/admin/users/:sub` body: what an admin needs to decide on a suspension (ADM-4). */
export interface AdminUserBody {
  sub: string;
  email?: string;
  status: Profile['status'];
  createdAt: string;
  activeJobs: number;
  /** Today's allowance, with any `dailyPoints` override (ADM-5) or abuse flag applied. */
  dailyLimit: number;
  pointsUsedToday: number;
  dailyPoints?: number;
  abuseFlag?: Profile['abuseFlag'];
  cooldownUntil?: string;
}

async function readProfileItem(deps: AdminDeps, sub: string): Promise<Profile | undefined> {
  const result = await deps.client.send(
    new GetCommand({
      TableName: deps.tableName,
      Key: { PK: userPk(sub), SK: PROFILE_SK },
      ConsistentRead: true,
    }),
  );
  return result.Item ? ({ ...result.Item, sub } as Profile) : undefined;
}

/** `GET /api/admin/users/:sub` (ADM-4): a user's profile and today's points, for admins. */
export async function getAdminUser(
  deps: AdminDeps,
  session: Session,
  sub: string,
): Promise<ApiResult> {
  const refusal = adminRefusal(session);
  if (refusal) return refusal;
  const notFound = apiError('not_found', 'User not found.');
  if (!userSubSchema.safeParse(sub).success) return notFound;
  const profile = await readProfileItem(deps, sub);
  if (!profile) return notFound;
  const body: AdminUserBody = {
    sub,
    ...(profile.email ? { email: profile.email } : {}),
    status: profile.status,
    createdAt: profile.createdAt,
    activeJobs: Math.max(0, profile.activeJobs ?? 0),
    dailyLimit: dailyLimit(profile, deps.defaultDailyPoints),
    pointsUsedToday: await readUsedPoints(deps.client, deps.tableName, sub, utcDate(deps.now())),
    ...(profile.dailyPoints !== undefined ? { dailyPoints: profile.dailyPoints } : {}),
    ...(profile.abuseFlag ? { abuseFlag: profile.abuseFlag } : {}),
    ...(profile.cooldownUntil ? { cooldownUntil: profile.cooldownUntil } : {}),
  };
  return { status: 200, body: { ...body } };
}

/**
 * `POST /api/admin/users/:sub/suspend` and `/unsuspend` (ADM-4): moves the profile between `active` and
 * `suspended`, and logs an `admin_action` entry with the admin's `sub`, in one transaction. A suspended user's
 * job, enhance and upload requests answer 403 from their next request. Doing it twice is safe; an account being
 * deleted can't be changed, and admins can't suspend themselves.
 */
export async function setSuspension(
  deps: AdminDeps,
  session: Session,
  sub: string,
  action: 'suspend' | 'unsuspend',
): Promise<ApiResult> {
  const refusal = adminRefusal(session);
  if (refusal) return refusal;
  const notFound = apiError('not_found', 'User not found.');
  if (!userSubSchema.safeParse(sub).success) return notFound;
  if (action === 'suspend' && sub === session.sub) {
    return apiError('invalid_request', "You can't suspend your own account.");
  }
  const [from, to] = action === 'suspend' ? ['active', 'suspended'] : ['suspended', 'active'];

  const now = deps.now();
  const log: ModlogItem = {
    PK: modlogPk(utcDate(now)),
    SK: deps.newId(),
    type: 'admin_action',
    action,
    userId: session.sub,
    targetUserId: sub,
    createdAt: now.toISOString(),
    ttl: ttlAfter(now, MODLOG_TTL_DAYS * SECONDS_PER_DAY),
  };
  try {
    await deps.client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: deps.tableName,
              Key: { PK: userPk(sub), SK: PROFILE_SK },
              UpdateExpression: 'SET #status = :to',
              ConditionExpression: 'attribute_exists(PK) AND #status = :from',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: { ':from': from, ':to': to },
            },
          },
          { Put: { TableName: deps.tableName, Item: log } },
        ],
      }),
    );
  } catch (error) {
    if (
      !(error instanceof TransactionCanceledException) ||
      error.CancellationReasons?.[0]?.Code !== 'ConditionalCheckFailed'
    ) {
      throw error;
    }
    const profile = await readProfileItem(deps, sub);
    if (!profile) return notFound;
    if (profile.status === to) return { status: 200, body: { sub, status: to } };
    return apiError('invalid_state', 'This account is being deleted, so it can’t be changed.');
  }
  return { status: 200, body: { sub, status: to } };
}
