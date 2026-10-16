import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { Provider } from '@pictora/core';

/** Providers with a queue of their own (tech design 3.2). Bedrock joins in P1. */
export type QueueProvider = Exclude<Provider, 'mock'>;

/** The dev-only mock provider has no queue of its own; its jobs share the OpenAI queue. */
export const MOCK_QUEUE_PROVIDER: QueueProvider = 'openai';

/** The environment variable holding a provider queue's URL, for example `OPENAI_QUEUE_URL`. */
export function queueUrlVariable(provider: QueueProvider): string {
  return `${provider.toUpperCase()}_QUEUE_URL`;
}

/** The URL of the queue that carries the provider's jobs, or undefined when it has none. */
export function queueUrl(
  provider: Provider,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const queueProvider = provider === 'mock' ? MOCK_QUEUE_PROVIDER : provider;
  return env[queueUrlVariable(queueProvider)] || undefined;
}

let client: SQSClient | undefined;

/** Sends the job message `{ jobId }` to the provider's queue (tech design 5.1). */
export async function enqueueJob(provider: Provider, jobId: string): Promise<void> {
  const url = queueUrl(provider);
  if (!url) throw new Error(`No queue is configured for provider ${provider}`);
  client ??= new SQSClient({});
  await client.send(
    new SendMessageCommand({ QueueUrl: url, MessageBody: JSON.stringify({ jobId }) }),
  );
}
