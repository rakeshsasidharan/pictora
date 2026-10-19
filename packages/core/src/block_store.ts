import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { QueryCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { PROFILE_SK, userPk } from './jobs.js';
import { BLOCK_WINDOW_MS, COOLDOWN_BLOCKS, COOLDOWN_MS, blockSk } from './moderation.js';

/** The single table and a client for it. */
export interface BlockTable {
  client: DynamoDBDocumentClient;
  tableName: string;
}

/**
 * Counts the user's blocks in the last 24 hours, and at 3 or more cools the account down until 24 hours from
 * now (PRD, Trust and safety): `cooldownUntil` on the profile, which job creation checks. Returns the new
 * `cooldownUntil`, or undefined when no cooldown was set. A later cooldown is never shortened. The worker
 * calls it after a blocked job, and the app after a blocked upload.
 */
export async function applyCooldown(
  { client, tableName }: BlockTable,
  sub: string,
  now: Date,
): Promise<string | undefined> {
  const since = new Date(now.getTime() - BLOCK_WINDOW_MS).toISOString();
  let blocks = 0;
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await client.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        // Expired items can linger until DynamoDB removes them, so the window is checked too.
        FilterExpression: 'createdAt >= :since',
        ExpressionAttributeValues: { ':pk': userPk(sub), ':prefix': blockSk(''), ':since': since },
        Select: 'COUNT',
        ConsistentRead: true,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    blocks += page.Count ?? 0;
    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey);
  if (blocks < COOLDOWN_BLOCKS) return undefined;

  const until = new Date(now.getTime() + COOLDOWN_MS).toISOString();
  try {
    await client.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { PK: userPk(sub), SK: PROFILE_SK },
        UpdateExpression: 'SET cooldownUntil = :until',
        ConditionExpression:
          'attribute_exists(PK) AND (attribute_not_exists(cooldownUntil) OR cooldownUntil < :until)',
        ExpressionAttributeValues: { ':until': until },
      }),
    );
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) return undefined;
    throw error;
  }
  return until;
}
