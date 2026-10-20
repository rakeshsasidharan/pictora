import { ulid } from 'ulid';
import { documentClient, tableName } from './dynamodb';
import { imagesBucketStorage, presignImage } from './images_bucket';
import type { JobsDeps } from './jobs';
import { appMetrics } from './observability';
import { spendCapCents } from './platform_spend';
import { defaultDailyPoints } from './profile';
import { enqueueJob, queueUrl } from './queues';
import { registryLoader } from './registry';

/** The job API's dependencies in a deployed app: DynamoDB, the registry, SQS, S3 and the app's metrics. */
export function jobsDeps(): JobsDeps {
  const storage = imagesBucketStorage();
  return {
    client: documentClient(),
    tableName: tableName(),
    models: () => registryLoader().models(),
    hasQueue: (provider) => queueUrl(provider) !== undefined,
    enqueue: enqueueJob,
    presign: presignImage,
    objectSize: storage.size,
    defaultDailyPoints: defaultDailyPoints(),
    spendCapCents: spendCapCents(),
    now: () => new Date(),
    newJobId: () => ulid(),
    metrics: appMetrics(),
  };
}
