import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  NotFound,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { MAX_UPLOAD_BYTES, UPLOAD_POST_EXPIRY_SECONDS } from '@pictora/core';

/** Presigned GET URLs last 15 minutes (tech design 9). */
export const PRESIGNED_GET_SECONDS = 15 * 60;

let client: S3Client | undefined;

function bucketName(): string {
  const bucket = process.env.IMAGES_BUCKET;
  if (!bucket) throw new Error('IMAGES_BUCKET is not set');
  return bucket;
}

function s3(): S3Client {
  client ??= new S3Client({});
  return client;
}

/**
 * A presigned GET URL for an object in the images bucket (`IMAGES_BUCKET`). With a download name, S3 answers
 * with `Content-Disposition: attachment`, so the browser saves the original file as is (GEN-7).
 */
export async function presignImage(key: string, downloadName?: string): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: bucketName(),
    Key: key,
    ...(downloadName ? { ResponseContentDisposition: attachment(downloadName) } : {}),
  });
  return getSignedUrl(s3(), command, { expiresIn: PRESIGNED_GET_SECONDS });
}

/** A `Content-Disposition` value that saves the file under the name, keeping only safe characters. */
export function attachment(name: string): string {
  return `attachment; filename="${name.replace(/[^A-Za-z0-9._-]/g, '_')}"`;
}

/** A presigned POST: the form's action URL and the fields to send before the file. */
export interface PresignedUpload {
  url: string;
  fields: Record<string, string>;
}

/** What the upload API does with the images bucket, so tests can swap it. */
export interface UploadStorage {
  /** A presigned POST for exactly this key and content type, up to 10 MB, valid for 5 minutes (EDIT-2). */
  presignUpload: (key: string, contentType: string) => Promise<PresignedUpload>;
  /** The object's size in bytes, or undefined when it doesn't exist. */
  size: (key: string) => Promise<number | undefined>;
  /** The object's bytes, or undefined when it doesn't exist. */
  read: (key: string) => Promise<Uint8Array | undefined>;
  write: (key: string, body: Uint8Array, contentType: string) => Promise<void>;
  remove: (key: string) => Promise<void>;
  /** A presigned GET URL, as `presignImage`. */
  presign: (key: string, downloadName?: string) => Promise<string>;
}

/**
 * The presigned POST for an upload (tech design 5.3): the key is fixed, the body must be 1 byte to 10 MB, and
 * the content type must be the one the browser asked for. S3 refuses any other upload with 403.
 */
export function presignUpload(
  s3Client: S3Client,
  bucket: string,
  key: string,
  contentType: string,
): Promise<PresignedUpload> {
  return createPresignedPost(s3Client, {
    Bucket: bucket,
    Key: key,
    Conditions: [
      ['content-length-range', 1, MAX_UPLOAD_BYTES],
      ['eq', '$Content-Type', contentType],
    ],
    Fields: { 'Content-Type': contentType },
    Expires: UPLOAD_POST_EXPIRY_SECONDS,
  });
}

/** The images bucket as upload storage, in a deployed app. */
export function imagesBucketStorage(): UploadStorage {
  return {
    presignUpload: (key, contentType) => presignUpload(s3(), bucketName(), key, contentType),
    async size(key) {
      try {
        const head = await s3().send(new HeadObjectCommand({ Bucket: bucketName(), Key: key }));
        return head.ContentLength ?? 0;
      } catch (error) {
        if (error instanceof NotFound || error instanceof NoSuchKey) return undefined;
        throw error;
      }
    },
    async read(key) {
      try {
        const object = await s3().send(new GetObjectCommand({ Bucket: bucketName(), Key: key }));
        return object.Body ? await object.Body.transformToByteArray() : new Uint8Array();
      } catch (error) {
        if (error instanceof NoSuchKey) return undefined;
        throw error;
      }
    },
    async write(key, body, contentType) {
      await s3().send(
        new PutObjectCommand({
          Bucket: bucketName(),
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      );
    },
    async remove(key) {
      await s3().send(new DeleteObjectCommand({ Bucket: bucketName(), Key: key }));
    },
    presign: presignImage,
  };
}
