import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { BETA_ALLOWLIST_PK, betaAllowlistSk, type BetaAllowlistItem } from './beta.js';

/** The single table and a client for it. */
export interface BetaTable {
  client: DynamoDBDocumentClient;
  tableName: string;
}

/** An allowlisted email as the admin area lists it. */
export interface BetaAllowlistEntry {
  email: string;
  addedAt: string;
  addedBy: string;
}

/** True when the email, in any case, is on the private beta allowlist. */
export async function isAllowlisted(
  { client, tableName }: BetaTable,
  email: string,
): Promise<boolean> {
  const result = await client.send(
    new GetCommand({
      TableName: tableName,
      Key: { PK: BETA_ALLOWLIST_PK, SK: betaAllowlistSk(email) },
      ProjectionExpression: 'PK',
    }),
  );
  return result.Item !== undefined;
}

/**
 * Puts an email on the allowlist. Adding one already there keeps its first `addedAt` and `addedBy`, so doing it
 * twice is safe. Returns the entry as stored.
 */
export async function addToAllowlist(
  { client, tableName }: BetaTable,
  { email, addedBy, now }: { email: string; addedBy: string; now: Date },
): Promise<BetaAllowlistEntry> {
  const sk = betaAllowlistSk(email);
  const item: BetaAllowlistItem = {
    PK: BETA_ALLOWLIST_PK,
    SK: sk,
    email: sk,
    addedAt: now.toISOString(),
    addedBy,
  };
  try {
    await client.send(
      new PutCommand({
        TableName: tableName,
        Item: item,
        ConditionExpression: 'attribute_not_exists(PK)',
      }),
    );
    return { email: item.email, addedAt: item.addedAt, addedBy };
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'ConditionalCheckFailedException') throw error;
    const existing = await client.send(
      new GetCommand({
        TableName: tableName,
        Key: { PK: BETA_ALLOWLIST_PK, SK: sk },
        ConsistentRead: true,
      }),
    );
    return toEntry((existing.Item as BetaAllowlistItem | undefined) ?? item);
  }
}

/** Takes an email off the allowlist; removing one that isn't there is safe. Returns whether it was there. */
export async function removeFromAllowlist(
  { client, tableName }: BetaTable,
  email: string,
): Promise<boolean> {
  const result = await client.send(
    new DeleteCommand({
      TableName: tableName,
      Key: { PK: BETA_ALLOWLIST_PK, SK: betaAllowlistSk(email) },
      ReturnValues: 'ALL_OLD',
    }),
  );
  return result.Attributes !== undefined;
}

/** The whole allowlist, in email order. A beta's list is small, so every page is read. */
export async function listAllowlist({
  client,
  tableName,
}: BetaTable): Promise<BetaAllowlistEntry[]> {
  const entries: BetaAllowlistEntry[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await client.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': BETA_ALLOWLIST_PK },
        ExclusiveStartKey: startKey,
        ConsistentRead: true,
      }),
    );
    for (const item of page.Items ?? []) entries.push(toEntry(item as BetaAllowlistItem));
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return entries;
}

/** An item added by hand may have only its keys. */
function toEntry(item: Partial<BetaAllowlistItem> & { SK: string }): BetaAllowlistEntry {
  return { email: item.email ?? item.SK, addedAt: item.addedAt ?? '', addedBy: item.addedBy ?? '' };
}
