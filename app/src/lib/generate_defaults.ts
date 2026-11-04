import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import {
  APP_GENERATE_DEFAULTS,
  DEFAULTS_SK,
  PROFILE_SK,
  generateDefaultsSchema,
  userPk,
  type GenerateDefaults,
} from '@pictora/core';
import { apiError, type ApiResult } from './jobs';
import { ensureProfile } from './profile';
import type { Session } from './session';

/** What the defaults API needs, so tests can swap DynamoDB and the clock. */
export interface DefaultsDeps {
  client: DynamoDBDocumentClient;
  tableName: string;
  now: () => Date;
}

const FIELDS = Object.keys(APP_GENERATE_DEFAULTS) as (keyof GenerateDefaults)[];

/**
 * The defaults as stored, field by field: a field that is missing or no longer valid (a style or aspect taken out
 * of the app since it was saved) takes the app default, so one stale value never discards the rest.
 */
export function defaultsFromItem(item: Record<string, unknown> | undefined): GenerateDefaults {
  const defaults: Record<string, unknown> = { ...APP_GENERATE_DEFAULTS };
  if (!item) return defaults as GenerateDefaults;
  for (const field of FIELDS) {
    const parsed = generateDefaultsSchema.shape[field].safeParse(item[field]);
    if (parsed.success) defaults[field] = parsed.data;
  }
  return defaults as GenerateDefaults;
}

async function readDefaultsItem(
  client: DynamoDBDocumentClient,
  tableName: string,
  sub: string,
): Promise<Record<string, unknown> | undefined> {
  const result = await client.send(
    new GetCommand({
      TableName: tableName,
      Key: { PK: userPk(sub), SK: DEFAULTS_SK },
      ConsistentRead: true,
    }),
  );
  return result.Item;
}

/** The user's generate defaults (GEN-11), or the app defaults until they save their own. */
export async function readGenerateDefaults(
  client: DynamoDBDocumentClient,
  tableName: string,
  sub: string,
): Promise<GenerateDefaults> {
  return defaultsFromItem(await readDefaultsItem(client, tableName, sub));
}

/** `GET /api/me/defaults`: the user's defaults, and whether they are their own or the app's. */
export async function getDefaults(deps: DefaultsDeps, session: Session): Promise<ApiResult> {
  const item = await readDefaultsItem(deps.client, deps.tableName, session.sub);
  return { status: 200, body: { defaults: defaultsFromItem(item), saved: item !== undefined } };
}

/**
 * `PUT /api/me/defaults` (GEN-11): stores every option the generate screen starts with. The write checks the
 * profile in the same transaction, so nothing is saved for an account being deleted, which the purge would miss.
 */
export async function saveDefaults(
  deps: DefaultsDeps,
  session: Session,
  input: unknown,
): Promise<ApiResult> {
  const parsed = generateDefaultsSchema.safeParse(input);
  if (!parsed.success) {
    return apiError('invalid_request', 'Choose a valid value for every setting.');
  }
  const now = deps.now();
  const refusal = await deletingRefusal(deps, session, now);
  if (refusal) return refusal;
  const updatedAt = now.toISOString();
  const failed = await writeGuarded(deps, session, {
    Put: {
      TableName: deps.tableName,
      Item: { PK: userPk(session.sub), SK: DEFAULTS_SK, ...parsed.data, updatedAt },
    },
  });
  return failed ?? { status: 200, body: { defaults: parsed.data, saved: true, updatedAt } };
}

/** `DELETE /api/me/defaults` (GEN-11): removes the user's defaults, so the app defaults apply again. */
export async function resetDefaults(deps: DefaultsDeps, session: Session): Promise<ApiResult> {
  const refusal = await deletingRefusal(deps, session, deps.now());
  if (refusal) return refusal;
  const failed = await writeGuarded(deps, session, {
    Delete: { TableName: deps.tableName, Key: { PK: userPk(session.sub), SK: DEFAULTS_SK } },
  });
  return failed ?? { status: 200, body: { defaults: APP_GENERATE_DEFAULTS, saved: false } };
}

/** 403 `account_deleting` once the user has asked to delete their account (AUTH-3). */
async function deletingRefusal(
  deps: DefaultsDeps,
  session: Session,
  now: Date,
): Promise<ApiResult | undefined> {
  const profile = await ensureProfile(deps.client, deps.tableName, session, now);
  return profile.status === 'deleting'
    ? apiError('account_deleting', 'Your account is being deleted.')
    : undefined;
}

type DefaultsWrite =
  | { Put: { TableName: string; Item: Record<string, unknown> } }
  | { Delete: { TableName: string; Key: Record<string, string> } };

/**
 * Runs the write with a check that the profile exists and isn't being deleted; undefined when it went through,
 * 403 when the check failed because deletion started in the meantime.
 */
async function writeGuarded(
  deps: DefaultsDeps,
  session: Session,
  write: DefaultsWrite,
): Promise<ApiResult | undefined> {
  try {
    await deps.client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: deps.tableName,
              Key: { PK: userPk(session.sub), SK: PROFILE_SK },
              ConditionExpression: 'attribute_exists(PK) AND #status <> :deleting',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: { ':deleting': 'deleting' },
            },
          },
          write,
        ],
      }),
    );
    return undefined;
  } catch (error) {
    // The profile check is the first item; any other cancellation (a conflicting write) is a real failure.
    if (
      error instanceof TransactionCanceledException &&
      error.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed'
    ) {
      return apiError('account_deleting', 'Your account is being deleted.');
    }
    throw error;
  }
}
