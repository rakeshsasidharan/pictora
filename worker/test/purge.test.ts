import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
  type ListObjectsV2CommandInput,
} from '@aws-sdk/client-s3';
import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { PROFILE_SK, userPk, type PurgeMessage } from '@pictora/core';
import { mockClient } from 'aws-sdk-client-mock';
import type { SQSEvent, SQSRecord } from 'aws-lambda';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_PURGE_WAITS,
  PURGE_WAIT_SECONDS,
  createPurgeHandler,
  purgeAccount,
  type PurgeDeps,
} from '../src/purge.js';
import { DYNAMODB_ENDPOINT, localTable } from './dynamodb_local.js';

const s3 = mockClient(S3Client);

function record(messageId: string, body: string): SQSRecord {
  return {
    messageId,
    receiptHandle: `handle-${messageId}`,
    body,
    attributes: {
      ApproximateReceiveCount: '1',
      SentTimestamp: '1700000000000',
      SenderId: 'sender',
      ApproximateFirstReceiveTimestamp: '1700000000001',
    },
    messageAttributes: {},
    md5OfBody: 'md5',
    eventSource: 'aws:sqs',
    eventSourceARN: 'arn:aws:sqs:us-west-2:000000000000:pictora-dev-purge',
    awsRegion: 'us-west-2',
  };
}

/** An S3 bucket held in memory, behind the mocked list and delete calls, listing `pageSize` keys at a time. */
function fakeBucket(keys: string[], pageSize = 1000) {
  const objects = new Set(keys);
  s3.on(ListObjectsV2Command).callsFake((input: ListObjectsV2CommandInput) => {
    const matching = [...objects].filter((key) => key.startsWith(input.Prefix ?? '')).sort();
    // Like S3, the token marks the last key listed, so deleting listed keys doesn't skip any.
    const after = input.ContinuationToken;
    const remaining = after ? matching.filter((key) => key > after) : matching;
    const page = remaining.slice(0, pageSize);
    const more = remaining.length > pageSize;
    return {
      Contents: page.map((Key) => ({ Key })),
      IsTruncated: more,
      ...(more ? { NextContinuationToken: page.at(-1) } : {}),
    };
  });
  s3.on(DeleteObjectsCommand).callsFake((input: { Delete: { Objects: { Key: string }[] } }) => {
    for (const { Key } of input.Delete.Objects) objects.delete(Key);
    return {};
  });
  return objects;
}

describe('createPurgeHandler', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs valid messages and reports invalid or failed ones as batch item failures', async () => {
    const run = vi.fn(async (message: PurgeMessage) => {
      if (message.sub === 'fails') throw new Error('S3 unavailable');
      return 'purged' as const;
    });
    const event: SQSEvent = {
      Records: [
        record('good', '{"sub":"abc","username":"abc"}'),
        record('bad', '{"sub":"abc"}'),
        record('throws', '{"sub":"fails","username":"fails"}'),
      ],
    };
    expect(await createPurgeHandler(run)(event)).toEqual({
      batchItemFailures: [{ itemIdentifier: 'bad' }, { itemIdentifier: 'throws' }],
    });
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe.skipIf(!DYNAMODB_ENDPOINT)('purgeAccount', () => {
  let table: ReturnType<typeof localTable>;
  let deleteUser: ReturnType<typeof vi.fn<PurgeDeps['deleteUser']>>;
  let requeue: ReturnType<typeof vi.fn<PurgeDeps['requeue']>>;

  beforeEach(async () => {
    table = localTable('pictora-purge');
    await table.create();
    s3.reset();
    deleteUser = vi.fn(async () => undefined);
    requeue = vi.fn(async () => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await table.drop();
  });

  const deps = (): PurgeDeps => ({
    client: table.client,
    tableName: table.tableName,
    s3: new S3Client({
      region: 'us-west-2',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    }),
    bucket: 'pictora-test-images',
    deleteUser,
    requeue,
  });
  const put = (Item: Record<string, unknown>) =>
    table.client.send(new PutCommand({ TableName: table.tableName, Item }));
  const itemsOf = async (pk: string) =>
    (
      await table.client.send(
        new QueryCommand({
          TableName: table.tableName,
          KeyConditionExpression: 'PK = :pk',
          ExpressionAttributeValues: { ':pk': pk },
        }),
      )
    ).Items ?? [];

  async function seedUser(sub: string, images: number, activeJobs = 0) {
    const pk = userPk(sub);
    await put({ PK: pk, SK: PROFILE_SK, status: 'deleting', activeJobs, email: 'u@example.com' });
    await put({ PK: pk, SK: 'USAGE#2026-10-15', used: 4 });
    await put({ PK: pk, SK: 'RATE#202610151200', count: 1 });
    await put({ PK: pk, SK: 'BLOCK#01J', stage: 'prompt' });
    for (let index = 0; index < images; index++) {
      const id = `IMG${String(index).padStart(4, '0')}`;
      await put({ PK: pk, SK: `IMG#${id}`, title: 'A lighthouse' });
      await put({ PK: pk, SK: `VER#${id}#1`, s3Key: `users/${sub}/${id}/v1.png` });
    }
  }

  it('deletes every item under the user, their objects, then the Cognito user', async () => {
    await seedUser('gone', 2);
    await seedUser('stays', 1);
    await put({ PK: 'JOB#01J', SK: 'META', userId: 'gone' });
    const objects = fakeBucket([
      'users/gone/IMG0000/v1.png',
      'users/gone/IMG0000/v1_thumb.webp',
      'users/gone/IMG0001/v1.png',
      'uploads/gone/01JUPLOAD',
      'users/stays/IMG0000/v1.png',
      'users/gonezo/IMG/v1.png',
    ]);

    expect(await purgeAccount(deps(), { sub: 'gone', username: 'google_1' })).toBe('purged');

    expect(await itemsOf(userPk('gone'))).toEqual([]);
    expect(await itemsOf(userPk('stays'))).toHaveLength(6);
    expect(await itemsOf('JOB#01J')).toHaveLength(1);
    expect([...objects].sort()).toEqual(['users/gonezo/IMG/v1.png', 'users/stays/IMG0000/v1.png']);
    expect(deleteUser).toHaveBeenCalledWith('google_1');
    expect(requeue).not.toHaveBeenCalled();
  });

  it('pages through large accounts', async () => {
    await seedUser('big', 40);
    const keys = Array.from({ length: 2500 }, (_, i) => `users/big/IMG${i}/v1.png`);
    const objects = fakeBucket(keys, 1000);
    await purgeAccount(deps(), { sub: 'big', username: 'big' });
    expect(await itemsOf(userPk('big'))).toEqual([]);
    expect(objects.size).toBe(0);
    expect(s3.commandCalls(DeleteObjectsCommand)).toHaveLength(3);
  });

  it('can run again after it has finished, or after it failed part way', async () => {
    await seedUser('retry', 1);
    const objects = fakeBucket(['users/retry/IMG0000/v1.png']);
    deleteUser.mockRejectedValueOnce(new Error('Cognito unavailable'));
    await expect(purgeAccount(deps(), { sub: 'retry', username: 'retry' })).rejects.toThrow(
      'Cognito unavailable',
    );
    expect(await itemsOf(userPk('retry'))).toEqual([]);
    expect(objects.size).toBe(0);

    expect(await purgeAccount(deps(), { sub: 'retry', username: 'retry' })).toBe('purged');
    expect(await purgeAccount(deps(), { sub: 'retry', username: 'retry' })).toBe('purged');
    expect(deleteUser).toHaveBeenCalledTimes(3);
  });

  it('keeps the profile when deleting objects fails, so the account stays marked deleting', async () => {
    await seedUser('partial', 1);
    s3.on(ListObjectsV2Command).resolves({ Contents: [{ Key: 'users/partial/x.png' }] });
    s3.on(DeleteObjectsCommand).resolves({ Errors: [{ Key: 'users/partial/x.png' }] });
    await expect(purgeAccount(deps(), { sub: 'partial', username: 'partial' })).rejects.toThrow(
      /could not be deleted/,
    );
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it('waits for running jobs to finish, then purges after at most 10 waits', async () => {
    await seedUser('busy', 1, 1);
    fakeBucket([]);
    expect(await purgeAccount(deps(), { sub: 'busy', username: 'busy' })).toBe('waiting');
    expect(requeue).toHaveBeenCalledWith(
      { sub: 'busy', username: 'busy', attempt: 1 },
      PURGE_WAIT_SECONDS,
    );
    expect(await itemsOf(userPk('busy'))).toHaveLength(6);
    expect(deleteUser).not.toHaveBeenCalled();

    expect(
      await purgeAccount(deps(), { sub: 'busy', username: 'busy', attempt: MAX_PURGE_WAITS }),
    ).toBe('purged');
    expect(await itemsOf(userPk('busy'))).toEqual([]);
  });

  it('purges a user whose profile is already gone', async () => {
    fakeBucket(['uploads/ghost/01J']);
    expect(await purgeAccount(deps(), { sub: 'ghost', username: 'ghost' })).toBe('purged');
    expect(deleteUser).toHaveBeenCalledWith('ghost');
  });
});
