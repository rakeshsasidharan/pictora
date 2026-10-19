import { createHash } from 'node:crypto';
import { PutCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  SIGN_UPS_PER_IP_PER_DAY,
  SIGN_UP_FLAG_SK,
  SIGN_UP_FLAG_TTL_SECONDS,
  SIGN_UP_IP_TTL_SECONDS,
  isDisposableEmail,
  signUpFlagPk,
  signUpIpPk,
  type AbuseFlag,
} from './abuse.js';
import { ttlAfter, utcDate } from './jobs.js';

/** The single table and a client for it. */
export interface AbuseTable {
  client: DynamoDBDocumentClient;
  tableName: string;
}

export interface SignUp {
  email: string;
  /** The sign-up's source IP, when the trigger knows it. */
  sourceIp?: string;
  now: Date;
}

/** A source IP as it is stored: hashed, so the table holds no raw addresses. */
export function hashIp(ip: string): string {
  return createHash('sha256').update(ip.trim()).digest('hex').slice(0, 32);
}

/**
 * Checks a new sign-up for abuse signals (PRD, Cost control; tech design 8): a disposable email domain, or more
 * than 3 sign-ups from its source IP today. A flagged sign-up gets a `SIGNUP#<email>` marker, which the app
 * copies to the profile it creates. Returns the flag, or undefined for a clean sign-up.
 */
export async function recordSignUp(
  { client, tableName }: AbuseTable,
  disposable: ReadonlySet<string>,
  { email, sourceIp, now }: SignUp,
): Promise<AbuseFlag | undefined> {
  let flag: AbuseFlag | undefined = isDisposableEmail(email, disposable)
    ? 'disposable_email'
    : undefined;
  if (sourceIp) {
    const result = await client.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { PK: signUpIpPk(utcDate(now)), SK: hashIp(sourceIp) },
        UpdateExpression: 'ADD #count :one SET #ttl = if_not_exists(#ttl, :ttl)',
        ExpressionAttributeNames: { '#count': 'count', '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':one': 1, ':ttl': ttlAfter(now, SIGN_UP_IP_TTL_SECONDS) },
        ReturnValues: 'UPDATED_NEW',
      }),
    );
    const count = Number(result.Attributes?.count ?? 0);
    if (!flag && count > SIGN_UPS_PER_IP_PER_DAY) flag = 'many_accounts';
  }
  if (flag) {
    await client.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          PK: signUpFlagPk(email),
          SK: SIGN_UP_FLAG_SK,
          abuseFlag: flag,
          createdAt: now.toISOString(),
          ttl: ttlAfter(now, SIGN_UP_FLAG_TTL_SECONDS),
        },
      }),
    );
  }
  return flag;
}
