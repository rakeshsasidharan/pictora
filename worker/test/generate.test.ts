import type { SQSEvent, SQSRecord } from 'aws-lambda';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGenerateHandler, parseJobMessage } from '../src/generate.js';

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
  let log: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs the job in a valid message and acknowledges it', async () => {
    const runJob = vi.fn(async () => 'succeeded' as const);
    const result = await createGenerateHandler(runJob)(
      event(record('m1', JSON.stringify({ jobId: '01JOB' }))),
    );

    expect(result).toEqual({ batchItemFailures: [] });
    expect(runJob).toHaveBeenCalledWith('01JOB');
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      message: 'Job message handled',
      jobId: '01JOB',
      outcome: 'succeeded',
      messageId: 'm1',
      queue: 'pictora-dev-openai',
    });
    expect(error).not.toHaveBeenCalled();
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
    expect(error).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toMatchObject({
      level: 'ERROR',
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
    expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toMatchObject({
      message: 'Job message failed',
      jobId: '01A',
      error: 'DynamoDB unavailable',
    });
  });

  it('returns no failures for an empty batch', async () => {
    expect(await createGenerateHandler(async () => 'skipped')(event())).toEqual({
      batchItemFailures: [],
    });
  });
});
