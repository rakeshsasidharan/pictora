import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import {
  BLOCK_TTL_SECONDS,
  MAX_UPLOAD_BYTES,
  MODLOG_TTL_DAYS,
  SECONDS_PER_DAY,
  UPLOAD_CONTENT_TYPES,
  UPLOAD_POST_EXPIRY_SECONDS,
  blockSk,
  blockingCategory,
  imageKey,
  imageSk,
  modlogPk,
  thumbnailKey,
  ttlAfter,
  uploadKey,
  uploadRequestSchema,
  userPk,
  utcDate,
  versionSk,
  type BlockItem,
  type ModlogItem,
} from '@pictora/core';
import { applyCooldown } from '@pictora/core/block-store';
import { NotAnImageError, type PreparedUpload } from '@pictora/providers/image';
import type { Moderate } from '@pictora/providers/text';
import { takeRateSlot } from './enhance';
import type { UploadStorage } from './images_bucket';
import { apiError, imageFileName, logError, profileRefusal, type ApiResult } from './jobs';
import { ensureProfile } from './profile';
import { TOO_LARGE_MESSAGE, WRONG_TYPE_MESSAGE } from './upload_files';
import type { Session } from './session';

/** What the upload API needs, so tests can swap S3, moderation, image decoding, the clock and the IDs. */
export interface UploadsDeps {
  client: DynamoDBDocumentClient;
  tableName: string;
  storage: UploadStorage;
  moderate: Moderate;
  /** Decodes and converts an upload; throws `NotAnImageError` for anything else. */
  prepare: (bytes: Uint8Array) => Promise<PreparedUpload>;
  now: () => Date;
  newId: () => string;
}

/** The title an uploaded image has in the gallery, where a generated one shows the start of its prompt. */
export const UPLOAD_TITLE = 'Uploaded image';

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** The `POST /api/uploads` body: where and how to POST the file, and the ID to complete it with. */
export interface UploadTicketBody {
  uploadId: string;
  /** The object the file goes to, `uploads/<sub>/<uploadId>`: an edit can use it as a reference image as is. */
  key: string;
  url: string;
  fields: Record<string, string>;
  expiresAt: string;
}

/** The `POST /api/uploads/:id/complete` body: the new image, whose version 1 is the upload as a PNG. */
export interface UploadedImageBody {
  image: {
    imageId: string;
    version: 1;
    width: number;
    height: number;
    url: string;
    downloadUrl: string;
  };
}

/**
 * `POST /api/uploads` (EDIT-2, tech design 5.3): checks the file's type and size and the account, counts the
 * request in the minute's rate window, and returns a presigned POST for `uploads/<sub>/<ulid>`. Uploads cost
 * no points.
 */
export async function createUpload(
  deps: UploadsDeps,
  session: Session,
  input: unknown,
): Promise<ApiResult> {
  const parsed = uploadRequestSchema.safeParse(input);
  if (!parsed.success) return uploadRequestError(input);
  const { contentType } = parsed.data;

  const now = deps.now();
  const profile = await ensureProfile(deps.client, deps.tableName, session, now);
  const refusal = profileRefusal(profile, now);
  if (refusal) return refusal;
  if (!(await takeRateSlot(deps.client, deps.tableName, session.sub, now))) {
    return apiError(
      'rate_limited',
      "You've made 10 requests in the last minute. Wait a moment, then try again.",
    );
  }

  const uploadId = deps.newId();
  const key = uploadKey(session.sub, uploadId);
  const { url, fields } = await deps.storage.presignUpload(key, contentType);
  const body: UploadTicketBody = {
    uploadId,
    key,
    url,
    fields,
    expiresAt: new Date(now.getTime() + UPLOAD_POST_EXPIRY_SECONDS * 1000).toISOString(),
  };
  return { status: 200, body: { ...body } };
}

/** The plain-language reason an upload request was refused: the file's type, its size, or anything else. */
function uploadRequestError(input: unknown): ApiResult {
  const { contentType, size } = (typeof input === 'object' && input !== null ? input : {}) as {
    contentType?: unknown;
    size?: unknown;
  };
  if (!(UPLOAD_CONTENT_TYPES as readonly unknown[]).includes(contentType)) {
    return apiError('upload_wrong_type', WRONG_TYPE_MESSAGE);
  }
  if (typeof size === 'number' && size > MAX_UPLOAD_BYTES) {
    return apiError('upload_too_large', TOO_LARGE_MESSAGE);
  }
  return apiError('invalid_request', "Something in the upload request isn't valid. Try again.");
}

/**
 * `POST /api/uploads/:id/complete` (EDIT-2): checks that the caller's upload exists, is at most 10 MB and is a
 * real JPEG, PNG or WebP image, then moderates it. An allowed upload becomes a new image: its PNG and
 * thumbnail are stored under `users/<sub>/<imageId>/`, with the `IMG#` and `VER#…#1` items (`source: 'upload'`);
 * the image ID is the upload ID, so completing twice answers with the same image. A flagged upload is deleted
 * and counted as a block, which can cool the account down. The upload key holds the caller's own `sub`, so
 * another user's upload ID is simply not found.
 */
export async function completeUpload(
  deps: UploadsDeps,
  session: Session,
  uploadId: string,
): Promise<ApiResult> {
  const notFound = apiError('not_found', 'Upload not found. Upload the image again.');
  if (!ULID_PATTERN.test(uploadId)) return notFound;

  const now = deps.now();
  const profile = await ensureProfile(deps.client, deps.tableName, session, now);
  const refusal = profileRefusal(profile, now);
  if (refusal) return refusal;

  const existing = await readUploadedVersion(deps, session.sub, uploadId);
  if (existing) return { status: 200, body: { ...(await imageBody(deps, existing)) } };

  const key = uploadKey(session.sub, uploadId);
  const size = await deps.storage.size(key);
  if (size === undefined) return notFound;
  if (size > MAX_UPLOAD_BYTES) {
    await deps.storage.remove(key);
    return apiError('upload_too_large', TOO_LARGE_MESSAGE);
  }
  const bytes = await deps.storage.read(key);
  if (!bytes) return notFound;

  let prepared: PreparedUpload;
  try {
    prepared = await deps.prepare(bytes);
  } catch (error) {
    if (!(error instanceof NotAnImageError)) throw error;
    await deps.storage.remove(key);
    return apiError('not_an_image', "That file isn't a JPEG, PNG or WebP image we can open.");
  }

  let category: string | undefined;
  try {
    category = blockingCategory(await deps.moderate({ image: prepared.moderationCopy }));
  } catch (error) {
    // The upload stays, so completing again can still use it once moderation is back.
    logError('Upload moderation failed', { uploadId, error });
    return apiError(
      'moderation_failed',
      "We couldn't check this image right now. Try again in a minute.",
    );
  }
  if (category) {
    await deps.storage.remove(key);
    await recordUploadBlock(deps, session.sub, uploadId, category, now);
    return apiError('blocked', 'This image was blocked by our content policy.');
  }

  const version = await storeUploadedImage(deps, session.sub, uploadId, prepared, now);
  try {
    await deps.storage.remove(key);
  } catch (error) {
    // The lifecycle rule removes it after a day anyway.
    logError('Upload not deleted after conversion', { uploadId, error });
  }
  return { status: 201, body: { ...(await imageBody(deps, version)) } };
}

/** The fields of a `VER#<imageId>#1` item the answer needs. */
interface UploadedVersion {
  imageId: string;
  s3Key: string;
  width: number;
  height: number;
}

async function readUploadedVersion(
  deps: UploadsDeps,
  sub: string,
  imageId: string,
): Promise<UploadedVersion | undefined> {
  const result = await deps.client.send(
    new GetCommand({
      TableName: deps.tableName,
      Key: { PK: userPk(sub), SK: versionSk(imageId, 1) },
      ConsistentRead: true,
    }),
  );
  return result.Item as UploadedVersion | undefined;
}

async function imageBody(deps: UploadsDeps, version: UploadedVersion): Promise<UploadedImageBody> {
  return {
    image: {
      imageId: version.imageId,
      version: 1,
      width: version.width,
      height: version.height,
      url: await deps.storage.presign(version.s3Key),
      downloadUrl: await deps.storage.presign(version.s3Key, imageFileName(version.imageId, 1)),
    },
  };
}

/**
 * Stores the PNG and its thumbnail, then the `IMG#` and `VER#…#1` items in one transaction. When a concurrent
 * completion of the same upload wrote them first, its items are kept and returned.
 */
async function storeUploadedImage(
  deps: UploadsDeps,
  sub: string,
  imageId: string,
  prepared: PreparedUpload,
  now: Date,
): Promise<UploadedVersion> {
  const s3Key = imageKey(sub, imageId, 1);
  const thumbKey = thumbnailKey(sub, imageId, 1);
  await deps.storage.write(s3Key, prepared.png, 'image/png');
  await deps.storage.write(thumbKey, prepared.thumbnail.webp, 'image/webp');

  const at = now.toISOString();
  const version = { imageId, s3Key, width: prepared.width, height: prepared.height };
  try {
    await deps.client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: deps.tableName,
              Item: {
                PK: userPk(sub),
                SK: imageSk(imageId),
                imageId,
                title: UPLOAD_TITLE,
                latestVersion: 1,
                versionCount: 1,
                source: 'upload',
                createdAt: at,
                thumbKey,
              },
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          {
            Put: {
              TableName: deps.tableName,
              Item: {
                PK: userPk(sub),
                SK: versionSk(imageId, 1),
                ...version,
                version: 1,
                thumbKey,
                source: 'upload',
                costPoints: 0,
                createdAt: at,
              },
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
        ],
      }),
    );
  } catch (error) {
    const stored =
      error instanceof TransactionCanceledException &&
      (await readUploadedVersion(deps, sub, imageId));
    if (!stored) throw error;
    return stored;
  }
  return version;
}

/**
 * Records a blocked upload as a block (tech design 6.3): a `BLOCK#` item, which counts towards the cooldown,
 * and a `MODLOG#` entry for review. Then cools the account down if it was the third block in 24 hours.
 */
async function recordUploadBlock(
  deps: UploadsDeps,
  sub: string,
  uploadId: string,
  category: string,
  now: Date,
): Promise<void> {
  const at = now.toISOString();
  const blockId = deps.newId();
  const block: BlockItem = {
    PK: userPk(sub),
    SK: blockSk(blockId),
    stage: 'image',
    category,
    uploadId,
    createdAt: at,
    ttl: ttlAfter(now, BLOCK_TTL_SECONDS),
  };
  const entry: ModlogItem = {
    PK: modlogPk(utcDate(now)),
    SK: blockId,
    type: 'block',
    userId: sub,
    stage: 'image',
    category,
    promptExcerpt: '',
    uploadId,
    createdAt: at,
    ttl: ttlAfter(now, MODLOG_TTL_DAYS * SECONDS_PER_DAY),
  };
  await deps.client.send(
    new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: deps.tableName, Item: block } },
        { Put: { TableName: deps.tableName, Item: entry } },
      ],
    }),
  );
  try {
    await applyCooldown(deps, sub, now);
  } catch (error) {
    logError('Cooldown check after a blocked upload failed', { uploadId, error });
  }
}
