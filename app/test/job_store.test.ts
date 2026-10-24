import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { JobItem } from '@pictora/core';
import { describe, expect, it, vi } from 'vitest';
import { reserveJob } from '../src/lib/job_store';

const job = {
  PK: 'JOB#01JAAAAAAAAAAAAAAAAAAAAAAA',
  SK: 'META',
  jobId: '01JAAAAAAAAAAAAAAAAAAAAAAA',
  userId: 'user',
  type: 'generate',
  status: 'queued',
  request: {
    type: 'generate',
    prompt: 'A fox',
    style: 'none',
    modelId: 'mock',
    aspect: '1:1',
    quality: 'draft',
    count: 2,
  },
  modelId: 'mock',
  provider: 'mock',
  pointsReserved: 2,
  usageDate: '2026-10-15',
  createdAt: '2026-10-15T12:00:00.000Z',
  attempts: 0,
  ttl: 0,
} as unknown as JobItem;

/** A transaction cancelled with one reason per item: rate, usage, profile, job. */
function cancelled(...codes: string[]) {
  return new TransactionCanceledException({
    message: 'Transaction cancelled',
    $metadata: {},
    CancellationReasons: codes.map((Code) => ({ Code })),
  });
}

function clientFailing(...errors: Error[]) {
  const send = vi.fn(async () => {
    const error = errors.shift();
    if (error) throw error;
    return {};
  });
  return { client: { send } as unknown as DynamoDBDocumentClient, send };
}

const input = { job, limit: 25, rateLimit: 10, now: new Date('2026-10-15T12:00:00Z') };

describe('reserveJob', () => {
  it('retries a transaction cancelled by a conflicting one', async () => {
    const { client, send } = clientFailing(
      cancelled('None', 'TransactionConflict', 'None', 'None'),
      cancelled('TransactionConflict', 'None', 'None', 'None'),
    );
    expect(await reserveJob(client, 'table', input)).toEqual({ ok: true });
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('gives up after repeated conflicts', async () => {
    const conflict = () => cancelled('None', 'None', 'TransactionConflict', 'None');
    const { client, send } = clientFailing(conflict(), conflict(), conflict(), conflict());
    await expect(reserveJob(client, 'table', input)).rejects.toThrow(TransactionCanceledException);
    expect(send).toHaveBeenCalledTimes(4);
  });

  it('reports which condition failed: the profile first, then the rate, then the points', async () => {
    const check = 'ConditionalCheckFailed';
    const cases: [string[], string][] = [
      [[check, check, check, 'None'], 'profile'],
      [[check, check, 'None', 'None'], 'rate'],
      [['None', check, 'None', 'None'], 'points'],
    ];
    for (const [codes, reason] of cases) {
      const { client } = clientFailing(cancelled(...codes));
      expect(await reserveJob(client, 'table', input)).toEqual({ ok: false, reason });
    }
  });

  it("checks the minute's counter against the rate limit it is given", async () => {
    const { client, send } = clientFailing();
    await reserveJob(client, 'table', { ...input, rateLimit: 50 });
    const [command] = send.mock.calls[0] as unknown as [
      {
        input: {
          TransactItems: {
            Update?: { Key: { SK: string }; ExpressionAttributeValues: Record<string, unknown> };
          }[];
        };
      },
    ];
    const rate = command.input.TransactItems.find((item) =>
      item.Update?.Key.SK.startsWith('RATE#'),
    );
    expect(rate?.Update?.ExpressionAttributeValues[':max']).toBe(50);
  });

  it("checks a batch job's profile without taking a concurrency slot", async () => {
    const { client, send } = clientFailing();
    const batchJob = {
      ...job,
      status: 'scheduled',
      request: { ...job.request, delivery: 'batch' },
    } as JobItem;
    await reserveJob(client, 'table', { ...input, job: batchJob });
    const [command] = send.mock.calls[0] as unknown as [
      {
        input: {
          TransactItems: {
            Update?: { Key: { SK: string }; UpdateExpression: string };
            ConditionCheck?: { Key: { SK: string }; ConditionExpression: string };
          }[];
        };
      },
    ];
    const profile = command.input.TransactItems[2];
    expect(profile?.Update).toBeUndefined();
    expect(profile?.ConditionCheck?.Key.SK).toBe('PROFILE');
    expect(profile?.ConditionCheck?.ConditionExpression).not.toContain('activeJobs');
    expect(profile?.ConditionCheck?.ConditionExpression).toContain('cooldownUntil');

    const { client: standardClient, send: standardSend } = clientFailing();
    await reserveJob(standardClient, 'table', input);
    const [standard] = standardSend.mock.calls[0] as unknown as [typeof command];
    expect(standard.input.TransactItems[2]?.Update?.UpdateExpression).toBe('ADD activeJobs :one');
  });

  it('rethrows other errors', async () => {
    const { client } = clientFailing(new Error('throttled'));
    await expect(reserveJob(client, 'table', input)).rejects.toThrow('throttled');
  });
});
