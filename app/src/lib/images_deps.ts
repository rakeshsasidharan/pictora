import { documentClient, tableName } from './dynamodb';
import { presignImage, removeImagePrefix } from './images_bucket';
import type { ImageDeleteDeps } from './images';

/** The image API's dependencies in a deployed app: DynamoDB and the images bucket. */
export function imagesDeps(): ImageDeleteDeps {
  return {
    client: documentClient(),
    tableName: tableName(),
    presign: presignImage,
    removePrefix: removeImagePrefix,
  };
}
