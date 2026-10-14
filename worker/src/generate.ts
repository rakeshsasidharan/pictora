import type { SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';

/** The message the app sends to a provider queue for each job (tech design 5.1). */
export interface JobMessage {
  readonly jobId: string;
}

/** Reads the job message from an SQS record body. Returns undefined when the body isn't a valid job message. */
export function parseJobMessage(body: string): JobMessage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const { jobId } = parsed as Record<string, unknown>;
  if (typeof jobId !== 'string' || jobId.trim() === '') return undefined;
  return { jobId };
}

/** The name of the queue a record came from, `pictora-<env>-<provider>`. */
function queueName(record: SQSRecord): string {
  return record.eventSourceARN.split(':').pop() ?? record.eventSourceARN;
}

/**
 * SQS consumer for the provider queues (tech design 3.2). This first version logs each job and acknowledges
 * it; the generate flow (moderate, call the provider, store, settle) builds on it. A record whose body isn't a
 * job message is reported as a batch item failure, so SQS retries it and, after 3 receives, moves it to the
 * dead-letter queue.
 */
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];
  for (const record of event.Records) {
    const message = parseJobMessage(record.body);
    if (!message) {
      console.error(
        JSON.stringify({
          level: 'ERROR',
          message: 'Invalid job message',
          messageId: record.messageId,
          queue: queueName(record),
          receiveCount: record.attributes.ApproximateReceiveCount,
        }),
      );
      batchItemFailures.push({ itemIdentifier: record.messageId });
      continue;
    }
    console.log(
      JSON.stringify({
        level: 'INFO',
        message: 'Job received',
        jobId: message.jobId,
        messageId: record.messageId,
        queue: queueName(record),
      }),
    );
  }
  return { batchItemFailures };
}
