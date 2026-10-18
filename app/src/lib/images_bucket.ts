import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/** Presigned GET URLs last 15 minutes (tech design 9). */
export const PRESIGNED_GET_SECONDS = 15 * 60;

let client: S3Client | undefined;

/**
 * A presigned GET URL for an object in the images bucket (`IMAGES_BUCKET`). With a download name, S3 answers
 * with `Content-Disposition: attachment`, so the browser saves the original file as is (GEN-7).
 */
export async function presignImage(key: string, downloadName?: string): Promise<string> {
  const bucket = process.env.IMAGES_BUCKET;
  if (!bucket) throw new Error('IMAGES_BUCKET is not set');
  client ??= new S3Client({});
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ...(downloadName ? { ResponseContentDisposition: attachment(downloadName) } : {}),
  });
  return getSignedUrl(client, command, { expiresIn: PRESIGNED_GET_SECONDS });
}

/** A `Content-Disposition` value that saves the file under the name, keeping only safe characters. */
export function attachment(name: string): string {
  return `attachment; filename="${name.replace(/[^A-Za-z0-9._-]/g, '_')}"`;
}
