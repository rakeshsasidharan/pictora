import {
  DeleteCommand,
  GetCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import {
  ABUSE_DAILY_POINTS,
  DEFAULT_DAILY_POINTS,
  PROFILE_SK,
  SIGN_UP_FLAG_SK,
  TOS_VERSION,
  isAbuseFlag,
  signUpFlagPk,
  userPk,
  type AbuseFlag,
} from '@pictora/core';
import { recordSignup } from '@pictora/core/metrics-store';
import { log } from './observability';
import type { Session } from './session';

/** `deleting` from the moment a user asks to delete their account until the purge removes the profile (AUTH-3). */
export const PROFILE_STATUSES = ['active', 'suspended', 'deleting'] as const;
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
  /** When the user accepted the terms and content policy at onboarding (AUTH-4). */
  tosAcceptedAt?: string;
  /** The `TOS_VERSION` they accepted. */
  tosVersion?: string;
  /** They confirmed they are 13 or older. */
  ageConfirmed?: boolean;
  /** An abuse signal at sign-up, which lowers the daily allowance to 5 points (PRD, Cost control). */
  abuseFlag?: AbuseFlag;
}

/**
 * Returns the user's profile, creating it on first use with the email and `createdAt` (tech design 8). One
 * conditional-free update both creates and reads it; the email follows the latest verified token. When this
 * call created it, the sign-up is counted for the success metrics, and an abuse flag the pre-sign-up trigger left
 * for the email is copied onto it.
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
  const profile = profileFromItem(session.sub, result.Attributes ?? {});
  if (profile.createdAt !== values[':now']) return profile;
  await countSignup(client, tableName, session.sub, now);
  if (!session.email) return profile;
  const abuseFlag = await takeSignUpFlag(client, tableName, session.sub, session.email);
  return abuseFlag ? { ...profile, abuseFlag: profile.abuseFlag ?? abuseFlag } : profile;
}

/**
 * Counts the `signup` success metric (tech design 11.1), once per user however many first requests race. A
 * failure is logged, never thrown: metrics must not stop anyone using the app.
 */
async function countSignup(
  client: DynamoDBDocumentClient,
  tableName: string,
  sub: string,
  now: Date,
): Promise<void> {
  try {
    await recordSignup({ client, tableName }, sub, now);
  } catch (error) {
    log('ERROR', 'Counting a sign-up failed', { userSub: sub, error });
  }
}

/**
 * Moves the pre-sign-up trigger's `SIGNUP#<email>` marker onto the new profile as `abuseFlag`, never replacing
 * one already set, then deletes the marker. Returns the flag, or undefined when the sign-up wasn't flagged.
 */
async function takeSignUpFlag(
  client: DynamoDBDocumentClient,
  tableName: string,
  sub: string,
  email: string,
): Promise<AbuseFlag | undefined> {
  const key = { PK: signUpFlagPk(email), SK: SIGN_UP_FLAG_SK };
  const marker = await client.send(
    new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }),
  );
  const abuseFlag = marker.Item?.abuseFlag;
  if (!isAbuseFlag(abuseFlag)) return undefined;
  await client.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { PK: userPk(sub), SK: PROFILE_SK },
      UpdateExpression: 'SET abuseFlag = if_not_exists(abuseFlag, :flag)',
      ExpressionAttributeValues: { ':flag': abuseFlag },
    }),
  );
  await client.send(new DeleteCommand({ TableName: tableName, Key: key }));
  return abuseFlag;
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
    status: PROFILE_STATUSES.find((status) => status === item.status) ?? 'active',
    activeJobs: typeof item.activeJobs === 'number' ? item.activeJobs : 0,
    dailyPoints:
      typeof dailyPoints === 'number' && Number.isInteger(dailyPoints) && dailyPoints >= 0
        ? dailyPoints
        : undefined,
    cooldownUntil: typeof item.cooldownUntil === 'string' ? item.cooldownUntil : undefined,
    tosAcceptedAt: typeof item.tosAcceptedAt === 'string' ? item.tosAcceptedAt : undefined,
    tosVersion: typeof item.tosVersion === 'string' ? item.tosVersion : undefined,
    ageConfirmed: item.ageConfirmed === true,
    abuseFlag: isAbuseFlag(item.abuseFlag) ? item.abuseFlag : undefined,
  };
}

/**
 * True once the user has confirmed their age and accepted the current terms (AUTH-4). A new `TOS_VERSION`
 * makes this false again, so everyone accepts the new text before their next image.
 */
export function onboardingComplete(
  profile: Pick<Profile, 'tosAcceptedAt' | 'tosVersion' | 'ageConfirmed'>,
  tosVersion: string = TOS_VERSION,
): boolean {
  return (
    profile.ageConfirmed === true &&
    profile.tosAcceptedAt !== undefined &&
    profile.tosVersion === tosVersion
  );
}

/**
 * The user's daily allowance (LIM-1): their `dailyPoints` override (ADM-5) wins; else 5 points for a flagged
 * account (never more than the default); else the environment default.
 */
export function dailyLimit(
  profile: Pick<Profile, 'dailyPoints' | 'abuseFlag'>,
  defaultPoints: number,
): number {
  if (profile.dailyPoints !== undefined) return profile.dailyPoints;
  return profile.abuseFlag ? Math.min(ABUSE_DAILY_POINTS, defaultPoints) : defaultPoints;
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
