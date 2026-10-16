import { GetCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DEFAULT_DAILY_POINTS, PROFILE_SK, userPk } from '@pictora/core';
import type { Session } from './session';

export const PROFILE_STATUSES = ['active', 'suspended'] as const;
export type ProfileStatus = (typeof PROFILE_STATUSES)[number];

/** The `USER#<sub>` / `PROFILE` item, as far as the job API reads it (tech design 4). */
export interface Profile {
  sub: string;
  email?: string;
  createdAt: string;
  status: ProfileStatus;
  activeJobs: number;
  /** Per-user daily allowance set by an admin (ADM-5); the default applies when absent. */
  dailyPoints?: number;
  /** ISO 8601 UTC time until which the user can't create jobs, after repeated blocks. */
  cooldownUntil?: string;
}

/**
 * Returns the user's profile, creating it on first use with the email and `createdAt` (tech design 8). One
 * conditional-free update both creates and reads it; the email follows the latest verified token.
 */
export async function ensureProfile(
  client: DynamoDBDocumentClient,
  tableName: string,
  session: Session,
  now: Date,
): Promise<Profile> {
  const assignments = [
    'createdAt = if_not_exists(createdAt, :now)',
    '#status = if_not_exists(#status, :active)',
    'activeJobs = if_not_exists(activeJobs, :zero)',
  ];
  const values: Record<string, unknown> = {
    ':now': now.toISOString(),
    ':active': 'active',
    ':zero': 0,
  };
  if (session.email) {
    assignments.push('email = :email');
    values[':email'] = session.email;
  }
  const result = await client.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { PK: userPk(session.sub), SK: PROFILE_SK },
      UpdateExpression: `SET ${assignments.join(', ')}`,
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    }),
  );
  return profileFromItem(session.sub, result.Attributes ?? {});
}

/** The profile as stored, read consistently; undefined when the user has none yet. */
export async function readProfile(
  client: DynamoDBDocumentClient,
  tableName: string,
  sub: string,
): Promise<Profile | undefined> {
  const result = await client.send(
    new GetCommand({
      TableName: tableName,
      Key: { PK: userPk(sub), SK: PROFILE_SK },
      ConsistentRead: true,
    }),
  );
  return result.Item ? profileFromItem(sub, result.Item) : undefined;
}

function profileFromItem(sub: string, item: Record<string, unknown>): Profile {
  const dailyPoints = item.dailyPoints;
  return {
    sub,
    email: typeof item.email === 'string' ? item.email : undefined,
    createdAt: typeof item.createdAt === 'string' ? item.createdAt : '',
    status: item.status === 'suspended' ? 'suspended' : 'active',
    activeJobs: typeof item.activeJobs === 'number' ? item.activeJobs : 0,
    dailyPoints:
      typeof dailyPoints === 'number' && Number.isInteger(dailyPoints) && dailyPoints >= 0
        ? dailyPoints
        : undefined,
    cooldownUntil: typeof item.cooldownUntil === 'string' ? item.cooldownUntil : undefined,
  };
}

/** The user's daily allowance: their `dailyPoints` override, else the environment default (LIM-1, ADM-5). */
export function dailyLimit(profile: Pick<Profile, 'dailyPoints'>, defaultPoints: number): number {
  return profile.dailyPoints ?? defaultPoints;
}

/** True while a cooldown is in force at `now`. */
export function inCooldown(profile: Pick<Profile, 'cooldownUntil'>, now: Date): boolean {
  return profile.cooldownUntil !== undefined && profile.cooldownUntil > now.toISOString();
}

/** The default daily allowance from `DAILY_POINTS` (set per environment by CDK), or 25. */
export function defaultDailyPoints(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.DAILY_POINTS);
  return env.DAILY_POINTS && Number.isInteger(value) && value >= 0 ? value : DEFAULT_DAILY_POINTS;
}
