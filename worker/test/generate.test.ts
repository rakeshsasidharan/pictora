import type { SQSEvent, SQSRecord } from 'aws-lambda';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGenerateHandler, parseJobMessage } from '../src/generate.js';
import { log } from '../src/log.js';

vi.mock('../src/log.js', () => ({ log: vi.fn() }));

const QUEUE_ARN = 'arn:aws:sqs:us-west-2:000000000000:pictora-dev-openai';

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
    eventSourceARN: QUEUE_ARN,
    awsRegion: 'us-west-2',
  };
}

function event(...records: SQSRecord[]): SQSEvent {
  return { Records: records };
}

describe('parseJobMessage', () => {
  it('reads the job ID', () => {
    expect(parseJobMessage('{"jobId":"01JOB"}')).toEqual({ jobId: '01JOB' });
  });

  it.each([
    'not json',
    '[]',
    'null',
    '"01JOB"',
    '{}',
    '{"jobId":""}',
    '{"jobId":"  "}',
    '{"jobId":7}',
  ])('rejects %s', (body) => {
    expect(parseJobMessage(body)).toBeUndefined();
  });
});

describe('generate handler', () => {
  const lines = (level: string) =>
    vi
      .mocked(log)
      .mock.calls.filter(([lineLevel]) => lineLevel === level)
      .map(([, message, fields]): Record<string, unknown> => ({ message, ...fields }));

  afterEach(() => {
    vi.mocked(log).mockClear();
  });

  it('runs the job in a valid message and acknowledges it', async () => {
    const runJob = vi.fn(async () => 'succeeded' as const);
    const result = await createGenerateHandler(runJob)(
      event(record('m1', JSON.stringify({ jobId: '01JOB' }))),
    );

    expect(result).toEqual({ batchItemFailures: [] });
    expect(runJob).toHaveBeenCalledWith('01JOB');
    expect(lines('INFO').at(-1)).toMatchObject({
      message: 'Job message handled',
      jobId: '01JOB',
      outcome: 'succeeded',
      messageId: 'm1',
      queue: 'pictora-dev-openai',
    });
    expect(lines('ERROR')).toEqual([]);
  });

  it('acknowledges a message whose job was skipped', async () => {
    const handler = createGenerateHandler(async () => 'skipped');
    expect(await handler(event(record('m1', '{"jobId":"01JOB"}')))).toEqual({
      batchItemFailures: [],
    });
  });

  it('reports only the records that are not job messages as batch item failures', async () => {
    const runJob = vi.fn(async () => 'succeeded' as const);
    const result = await createGenerateHandler(runJob)(
      event(
        record('good-1', '{"jobId":"01A"}'),
        record('bad-json', '{jobId'),
        record('good-2', '{"jobId":"01B"}'),
        record('no-job-id', '{"id":"01C"}'),
      ),
    );

    expect(result).toEqual({
      batchItemFailures: [{ itemIdentifier: 'bad-json' }, { itemIdentifier: 'no-job-id' }],
    });
    expect(runJob).toHaveBeenCalledTimes(2);
    expect(lines('ERROR')).toHaveLength(2);
    expect(lines('ERROR')[0]).toMatchObject({
      message: 'Invalid job message',
      messageId: 'bad-json',
      receiveCount: '1',
    });
  });

  it('reports a job that threw as a batch item failure and carries on with the batch', async () => {
    const runJob = vi.fn(async (jobId: string) => {
      if (jobId === '01A') throw new Error('DynamoDB unavailable');
      return 'failed' as const;
    });
    const result = await createGenerateHandler(runJob)(
      event(record('m1', '{"jobId":"01A"}'), record('m2', '{"jobId":"01B"}')),
    );
    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: 'm1' }] });
    expect(runJob).toHaveBeenCalledTimes(2);
    expect(lines('ERROR')[0]).toMatchObject({ message: 'Job message failed', jobId: '01A' });
    expect(String(lines('ERROR')[0]?.error)).toContain('DynamoDB unavailable');
  });

  it('returns no failures for an empty batch', async () => {
    expect(await createGenerateHandler(async () => 'skipped')(event())).toEqual({
      batchItemFailures: [],
    });
  });
});
