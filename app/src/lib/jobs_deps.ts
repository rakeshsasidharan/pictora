import { ulid } from 'ulid';
import { documentClient, tableName } from './dynamodb';
import { presignImage } from './images_bucket';
import type { JobsDeps } from './jobs';
import { appMetrics } from './observability';
import { defaultDailyPoints } from './profile';
import { enqueueJob, queueUrl } from './queues';
import { registryLoader } from './registry';

/** The job API's dependencies in a deployed app: DynamoDB, the registry, SQS, S3 and the app's metrics. */
export function jobsDeps(): JobsDeps {
  return {
    client: documentClient(),
    tableName: tableName(),
    models: () => registryLoader().models(),
    hasQueue: (provider) => queueUrl(provider) !== undefined,
    enqueue: enqueueJob,
    presign: presignImage,
    defaultDailyPoints: defaultDailyPoints(),
    now: () => new Date(),
    newJobId: () => ulid(),
    metrics: appMetrics(),
  };
}
