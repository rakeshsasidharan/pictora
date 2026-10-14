import type { SQSEvent, SQSRecord } from 'aws-lambda';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handler, parseJobMessage } from '../src/generate.js';

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

  it('acknowledges a valid job message and logs its job ID', async () => {
    const result = await handler(event(record('m1', JSON.stringify({ jobId: '01JOB' }))));

    expect(result).toEqual({ batchItemFailures: [] });
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      message: 'Job received',
      jobId: '01JOB',
      messageId: 'm1',
      queue: 'pictora-dev-openai',
    });
    expect(error).not.toHaveBeenCalled();
  });

  it('reports only the records that are not job messages as batch item failures', async () => {
    const result = await handler(
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
    expect(log).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toMatchObject({
      level: 'ERROR',
      messageId: 'bad-json',
      receiveCount: '1',
    });
  });

  it('returns no failures for an empty batch', async () => {
    expect(await handler(event())).toEqual({ batchItemFailures: [] });
  });
});
