import {
  AdminDeleteUserCommand,
  CognitoIdentityProviderClient,
  UserNotFoundException,
} from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  PROFILE_SK,
  parsePurgeMessage,
  userObjectPrefixes,
  userPk,
  type PurgeMessage,
} from '@pictora/core';
import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { log } from './log.js';

/** What the purge needs, so tests can swap DynamoDB, S3, Cognito and the queue. */
export interface PurgeDeps {
  client: DynamoDBDocumentClient;
  tableName: string;
  s3: S3Client;
  bucket: string;
  /** Deletes the Cognito user (`AdminDeleteUser`); a user already gone counts as deleted. */
  deleteUser: (username: string) => Promise<void>;
  /** Puts a purge message back on the queue, to run again after `delaySeconds`. */
  requeue: (message: PurgeMessage, delaySeconds: number) => Promise<void>;
}

/**
 * While the user still has jobs running, the purge waits a minute at a time, up to 10 times, so a job that
 * finishes doesn't write its images back after the purge. Jobs never run that long: the sweeper fails any job
 * running over 5 minutes or queued over 10.
 */
export const PURGE_WAIT_SECONDS = 60;
export const MAX_PURGE_WAITS = 10;

/** DynamoDB deletes are at most 25 to a BatchWriteItem call; S3 deletes at most 1,000 to a DeleteObjects call. */
const DYNAMO_BATCH = 25;
const S3_BATCH = 1000;
const MAX_BATCH_ATTEMPTS = 5;

export type PurgeOutcome = 'purged' | 'waiting';

/**
 * Deletes an account (AUTH-3): every item under `USER#<sub>` (the profile last, so a purge that fails part way
 * still leaves the account marked `deleting`), every object under `users/<sub>/` and `uploads/<sub>/`, then the
 * Cognito user. Each step skips what is already gone, so a retried message finishes the job. Jobs and `MODLOG`
 * entries aren't under the user and expire through their TTLs.
 */
export async function purgeAccount(deps: PurgeDeps, message: PurgeMessage): Promise<PurgeOutcome> {
  const fields = { sub: message.sub, attempt: message.attempt ?? 0 };
  const profile = await deps.client.send(
    new GetCommand({
      TableName: deps.tableName,
      Key: { PK: userPk(message.sub), SK: PROFILE_SK },
      ConsistentRead: true,
    }),
  );
  const activeJobs = profile.Item?.activeJobs;
  const attempt = message.attempt ?? 0;
  if (typeof activeJobs === 'number' && activeJobs > 0 && attempt < MAX_PURGE_WAITS) {
    await deps.requeue({ ...message, attempt: attempt + 1 }, PURGE_WAIT_SECONDS);
    log('INFO', 'Purge waiting for running jobs', { ...fields, activeJobs });
    return 'waiting';
  }

  const items = await deleteUserItems(deps, message.sub);
  let objects = 0;
  for (const prefix of userObjectPrefixes(message.sub)) {
    objects += await deletePrefix(deps, prefix);
  }
  await deps.deleteUser(message.username);
  log('INFO', 'Account purged', { ...fields, items, objects });
  return 'purged';
}

async function deleteUserItems(deps: PurgeDeps, sub: string): Promise<number> {
  const pk = userPk(sub);
  const keys: { PK: string; SK: string }[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await deps.client.send(
      new QueryCommand({
        TableName: deps.tableName,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': pk },
        ProjectionExpression: 'PK, SK',
        ConsistentRead: true,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    keys.push(...((page.Items ?? []) as { PK: string; SK: string }[]));
    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey);

  const ordered = [
    ...keys.filter((key) => key.SK !== PROFILE_SK),
    ...keys.filter((key) => key.SK === PROFILE_SK),
  ];
  for (let start = 0; start < ordered.length; start += DYNAMO_BATCH) {
    await deleteBatch(deps, ordered.slice(start, start + DYNAMO_BATCH));
  }
  return ordered.length;
}

async function deleteBatch(deps: PurgeDeps, keys: { PK: string; SK: string }[]): Promise<void> {
  let requests = keys.map((Key) => ({ DeleteRequest: { Key } }));
  for (let attempt = 1; requests.length > 0; attempt++) {
    if (attempt > MAX_BATCH_ATTEMPTS) {
      throw new Error(`${requests.length} items were still unprocessed after retries`);
    }
    const result = await deps.client.send(
      new BatchWriteCommand({ RequestItems: { [deps.tableName]: requests } }),
    );
    requests = (result.UnprocessedItems?.[deps.tableName] ?? []) as typeof requests;
    if (requests.length > 0) await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt));
  }
}

/** Deletes every object under the prefix; returns how many. */
async function deletePrefix(deps: PurgeDeps, prefix: string): Promise<number> {
  let deleted = 0;
  let continuationToken: string | undefined;
  do {
    const page = await deps.s3.send(
      new ListObjectsV2Command({
        Bucket: deps.bucket,
        Prefix: prefix,
        MaxKeys: S3_BATCH,
        ContinuationToken: continuationToken,
      }),
    );
    const keys = (page.Contents ?? []).flatMap((object) => (object.Key ? [object.Key] : []));
    if (keys.length > 0) {
      const result = await deps.s3.send(
        new DeleteObjectsCommand({
          Bucket: deps.bucket,
          Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
        }),
      );
      if (result.Errors && result.Errors.length > 0) {
        throw new Error(`${result.Errors.length} objects under ${prefix} could not be deleted`);
      }
      deleted += keys.length;
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
  return deleted;
}

/**
 * Builds the purge queue consumer. A record that isn't a purge message, or whose purge threw, is reported as a
 * batch item failure, so SQS retries it and, after 3 receives, moves it to the dead-letter queue (which alarms).
 */
export function createPurgeHandler(
  run: (message: PurgeMessage) => Promise<PurgeOutcome>,
): (event: SQSEvent) => Promise<SQSBatchResponse> {
  return async (event) => {
    const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];
    for (const record of event.Records) {
      const message = parsePurgeMessage(record.body);
      if (!message) {
        log('ERROR', 'Invalid purge message', { messageId: record.messageId });
        batchItemFailures.push({ itemIdentifier: record.messageId });
        continue;
      }
      try {
        await run(message);
      } catch (error) {
        log('ERROR', 'Purge failed', { messageId: record.messageId, sub: message.sub, error });
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }
    return { batchItemFailures };
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/** The purge's dependencies in a deployed worker: the table, the images bucket, the user pool and the queue. */
export function purgeDeps(): PurgeDeps {
  const endpoint = process.env.DYNAMODB_ENDPOINT;
  const userPoolId = required('COGNITO_USER_POOL_ID');
  const queueUrl = required('PURGE_QUEUE_URL');
  const cognito = new CognitoIdentityProviderClient({});
  const sqs = new SQSClient({});
  return {
    client: DynamoDBDocumentClient.from(new DynamoDBClient(endpoint ? { endpoint } : {})),
    tableName: required('TABLE_NAME'),
    s3: new S3Client({}),
    bucket: required('IMAGES_BUCKET'),
    deleteUser: async (username) => {
      try {
        await cognito.send(
          new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: username }),
        );
      } catch (error) {
        if (!(error instanceof UserNotFoundException)) throw error;
      }
    },
    requeue: async (message, delaySeconds) => {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify(message),
          DelaySeconds: delaySeconds,
        }),
      );
    },
  };
}

let deps: PurgeDeps | undefined;

/** The deployed consumer of the purge queue. */
export const handler = createPurgeHandler((message) => {
  deps ??= purgeDeps();
  return purgeAccount(deps, message);
});
