import { ulid } from 'ulid';
import type { AdminDeps } from './admin_stats';
import { documentClient, tableName } from './dynamodb';
import { presignImage } from './images_bucket';
import { spendCapCents } from './platform_spend';
import { defaultDailyPoints } from './profile';
import { registryLoader } from './registry';

/** The admin APIs' dependencies in a deployed app: DynamoDB, the registry and the images bucket. */
export function adminDeps(): AdminDeps {
  return {
    client: documentClient(),
    tableName: tableName(),
    models: () => registryLoader().models(),
    presign: (key) => presignImage(key),
    spendCapCents: spendCapCents(),
    defaultDailyPoints: defaultDailyPoints(),
    now: () => new Date(),
    newId: () => ulid(),
  };
}
