import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/** Presigned GET URLs last 15 minutes (tech design 9). */
export const PRESIGNED_GET_SECONDS = 15 * 60;

let client: S3Client | undefined;

/** A presigned GET URL for an object in the images bucket (`IMAGES_BUCKET`). */
export async function presignImage(key: string): Promise<string> {
  const bucket = process.env.IMAGES_BUCKET;
  if (!bucket) throw new Error('IMAGES_BUCKET is not set');
  client ??= new S3Client({});
  return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), {
    expiresIn: PRESIGNED_GET_SECONDS,
  });
}
