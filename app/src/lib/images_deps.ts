import { documentClient, tableName } from './dynamodb';
import { modelNames } from './gallery_models';
import { presignImage, removeImagePrefix } from './images_bucket';
import type { ImageDeleteDeps } from './images';

/** The image API's dependencies in a deployed app: DynamoDB, the images bucket and the model registry. */
export function imagesDeps(): ImageDeleteDeps {
  return {
    client: documentClient(),
    tableName: tableName(),
    presign: presignImage,
    removePrefix: removeImagePrefix,
    modelNames,
  };
}
