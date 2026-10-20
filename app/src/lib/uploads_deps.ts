import { prepareUpload } from '@pictora/providers/image';
import { createModerator, secretApiKey, type Moderate } from '@pictora/providers/text';
import { ulid } from 'ulid';
import { documentClient, tableName } from './dynamodb';
import { imagesBucketStorage } from './images_bucket';
import type { UploadsDeps } from './uploads';

let moderate: Moderate | undefined;

/**
 * The upload API's dependencies in a deployed app: DynamoDB, the images bucket, and moderation with the OpenAI
 * key from the secret named in `OPENAI_SECRET_ID`.
 */
export function uploadsDeps(): UploadsDeps {
  const secretId = process.env.OPENAI_SECRET_ID;
  if (!secretId) throw new Error('OPENAI_SECRET_ID is not set');
  moderate ??= createModerator({ apiKey: secretApiKey(secretId) });
  return {
    client: documentClient(),
    tableName: tableName(),
    storage: imagesBucketStorage(),
    moderate,
    prepare: prepareUpload,
    now: () => new Date(),
    newId: () => ulid(),
  };
}
