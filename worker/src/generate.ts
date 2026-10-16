import type { SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import { pipelineDeps } from './deps.js';
import { log } from './log.js';
import { processJob, type JobOutcome } from './pipeline.js';

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
 * Builds the SQS consumer for the provider queues (tech design 3.2). Each job runs through `runJob`, which routes
 * by the job's own provider, since mock jobs share the openai queue. A record whose body isn't a job message,
 * or whose job threw before it could be recorded, is reported as a batch item failure, so SQS retries it and,
 * after 3 receives, moves it to the dead-letter queue. A retry never reaches the provider again: the job is no
 * longer queued, and the sweeper refunds it if it stays running.
 */
export function createGenerateHandler(
  runJob: (jobId: string) => Promise<JobOutcome>,
): (event: SQSEvent) => Promise<SQSBatchResponse> {
  return async (event) => {
    const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];
    for (const record of event.Records) {
      const fields = {
        messageId: record.messageId,
        queue: queueName(record),
        receiveCount: record.attributes.ApproximateReceiveCount,
      };
      const message = parseJobMessage(record.body);
      if (!message) {
        log('ERROR', 'Invalid job message', fields);
        batchItemFailures.push({ itemIdentifier: record.messageId });
        continue;
      }
      try {
        const outcome = await runJob(message.jobId);
        log('INFO', 'Job message handled', { ...fields, jobId: message.jobId, outcome });
      } catch (error) {
        log('ERROR', 'Job message failed', { ...fields, jobId: message.jobId, error });
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }
    return { batchItemFailures };
  };
}

let deps: ReturnType<typeof pipelineDeps> | undefined;

/** The deployed consumer; its clients and registry cache live as long as the Lambda instance. */
export const handler = createGenerateHandler((jobId) => {
  deps ??= pipelineDeps();
  return processJob(deps, jobId);
});
