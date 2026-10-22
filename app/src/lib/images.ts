import { BatchWriteCommand, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  activeJobsGsiPk,
  imageSk,
  userPk,
  versionSk,
  type ActiveJobStatus,
  type Aspect,
  type JobItem,
  type JobType,
  type Quality,
  type StyleId,
} from '@pictora/core';
import { apiError, imageFileName, logError, type ApiResult, type JobsDeps } from './jobs';
import type { Session } from './session';

/** What reading images needs: the table and presigned URLs, as the job API has them. */
export type ImagesDeps = Pick<JobsDeps, 'client' | 'tableName' | 'presign'>;

/** What deleting an image needs on top: removing every object under an S3 prefix. */
export interface ImageDeleteDeps extends ImagesDeps {
  /** Deletes every object in the images bucket whose key starts with the prefix. */
  removePrefix: (prefix: string) => Promise<void>;
}

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Images per gallery page (GAL-1). */
export const GALLERY_PAGE_SIZE = 24;

/** DynamoDB deletes at most 25 items in one `BatchWriteItem` call. */
const DELETE_BATCH = 25;
const MAX_BATCH_ATTEMPTS = 5;

/** One version of an image, as the edit panel and detail view show it (EDIT-1, EDIT-3, GAL-2). */
export interface ImageVersionBody {
  version: number;
  /** The version this one was edited from; absent for version 1. */
  parentVersion?: number;
  /** The words the version was edited with. */
  editInstruction?: string;
  /** The user's prompt, for a generated version 1. */
  prompt?: string;
  enhancedPrompt?: string;
  /** The words to avoid, for a generated version 1. */
  avoid?: string;
  /** `upload` for an uploaded version 1. */
  source?: 'upload';
  modelId?: string;
  style?: StyleId;
  quality?: Quality;
  aspect?: Aspect;
  /** The seed the provider reported, where the model has one (GAL-2). */
  seed?: number;
  transparentBackground?: boolean;
  width: number;
  height: number;
  createdAt?: string;
  /** Presigned URLs (15 minutes): the PNG, the PNG as a download, and the WebP thumbnail. */
  url: string;
  downloadUrl: string;
  thumbUrl: string;
}

/** The `GET /api/images/:id` body. */
export interface ImageDetailBody {
  image: {
    imageId: string;
    title: string;
    latestVersion: number;
    versionCount: number;
    source?: 'upload';
    style?: StyleId;
    modelId?: string;
    createdAt?: string;
  };
  /** Every version, oldest first. */
  versions: ImageVersionBody[];
}

interface ImageItem {
  imageId: string;
  title: string;
  latestVersion: number;
  versionCount: number;
  source?: 'upload';
  style?: StyleId;
  modelId?: string;
  createdAt?: string;
  /** The latest version's thumbnail. */
  thumbKey?: string;
}

interface VersionItem {
  version: number;
  s3Key: string;
  thumbKey: string;
  width: number;
  height: number;
  parentVersion?: number;
  editInstruction?: string;
  prompt?: string;
  enhancedPrompt?: string;
  avoid?: string;
  source?: 'upload';
  modelId?: string;
  style?: StyleId;
  quality?: Quality;
  aspect?: Aspect;
  seed?: number;
  transparentBackground?: boolean;
  createdAt?: string;
}

/**
 * `GET /api/images/:id` (tech design 7): the caller's image with all its versions, oldest first, each with
 * presigned URLs. Another user's image answers 404, the same as one that doesn't exist.
 */
export async function getImageDetail(
  deps: ImagesDeps,
  session: Session,
  imageId: string,
): Promise<ApiResult> {
  const notFound = apiError('not_found', 'Image not found.');
  if (!ULID_PATTERN.test(imageId)) return notFound;
  const pk = userPk(session.sub);
  const image = await readImage(deps, pk, imageId);
  if (!image) return notFound;

  const items = await queryVersions(deps, pk, imageId);

  // Only the owner's own objects are ever presigned.
  const prefix = `users/${session.sub}/`;
  const versions = await Promise.all(
    items
      .filter((item) => item.s3Key.startsWith(prefix) && item.thumbKey.startsWith(prefix))
      .map(async (item): Promise<ImageVersionBody> => {
        const [url, downloadUrl, thumbUrl] = await Promise.all([
          deps.presign(item.s3Key),
          deps.presign(item.s3Key, imageFileName(imageId, item.version)),
          deps.presign(item.thumbKey),
        ]);
        return {
          version: item.version,
          ...optional('parentVersion', item.parentVersion),
          ...optional('editInstruction', item.editInstruction),
          ...optional('prompt', item.prompt),
          ...optional('enhancedPrompt', item.enhancedPrompt),
          ...optional('avoid', item.avoid),
          ...optional('source', item.source),
          ...optional('modelId', item.modelId),
          ...optional('style', item.style),
          ...optional('quality', item.quality),
          ...optional('aspect', item.aspect),
          ...optional('seed', item.seed),
          ...optional('transparentBackground', item.transparentBackground),
          width: item.width,
          height: item.height,
          ...optional('createdAt', item.createdAt),
          url,
          downloadUrl,
          thumbUrl,
        };
      }),
  );
  const body: ImageDetailBody = {
    image: {
      imageId,
      title: image.title,
      latestVersion: image.latestVersion,
      versionCount: image.versionCount,
      ...optional('source', image.source),
      ...optional('style', image.style),
      ...optional('modelId', image.modelId),
      ...optional('createdAt', image.createdAt),
    },
    versions,
  };
  return { status: 200, body: { ...body } };
}

/** One image in the gallery grid (GAL-1): its latest version's thumbnail as a presigned URL. */
export interface GalleryImageBody {
  imageId: string;
  title: string;
  latestVersion: number;
  versionCount: number;
  source?: 'upload';
  createdAt?: string;
  thumbUrl: string;
}

/** A job still queued or running, shown as a placeholder at the top of the gallery (GEN-8). */
export interface ActiveJobBody {
  jobId: string;
  type: JobType;
  status: ActiveJobStatus;
  createdAt: string;
  /** The prompt of a generate job, or the instruction of an edit. */
  text: string;
  /** How many images the job makes. */
  count: number;
  /** The image an edit adds a version to. */
  imageId?: string;
}

/** The `GET /api/images` body. */
export interface GalleryPageBody {
  /** Newest first. */
  images: GalleryImageBody[];
  /** Pass as `?cursor=` for the next page; absent on the last page. */
  nextCursor?: string;
  /** The caller's queued and running jobs, newest first; on the first page only. */
  jobs?: ActiveJobBody[];
}

/**
 * `GET /api/images?cursor=` (GAL-1, GEN-8): a page of the caller's images, newest first, 24 to a page, each with
 * a presigned thumbnail. The cursor is the ID of the last image on the previous page. The first page also lists
 * the caller's jobs that are still queued or running.
 */
export async function listImages(
  deps: ImagesDeps,
  session: Session,
  cursor?: string | null,
): Promise<ApiResult> {
  if (cursor && !ULID_PATTERN.test(cursor)) {
    return apiError('invalid_request', 'That page of the gallery is not valid.');
  }
  const pk = userPk(session.sub);
  const [page, jobs] = await Promise.all([
    deps.client.send(
      new QueryCommand({
        TableName: deps.tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        ExpressionAttributeValues: { ':pk': pk, ':prefix': 'IMG#' },
        ScanIndexForward: false,
        Limit: GALLERY_PAGE_SIZE,
        ...(cursor ? { ExclusiveStartKey: { PK: pk, SK: imageSk(cursor) } } : {}),
      }),
    ),
    cursor ? Promise.resolve(undefined) : activeJobs(deps, session.sub),
  ]);
  const items = (page.Items ?? []) as ImageItem[];
  // Only the owner's own objects are ever presigned.
  const prefix = `users/${session.sub}/`;
  const images = await Promise.all(
    items
      .filter((item) => item.thumbKey?.startsWith(prefix))
      .map(async (item): Promise<GalleryImageBody> => ({
        imageId: item.imageId,
        title: item.title,
        latestVersion: item.latestVersion,
        versionCount: item.versionCount,
        ...optional('source', item.source),
        ...optional('createdAt', item.createdAt),
        thumbUrl: await deps.presign(item.thumbKey!),
      })),
  );
  const last = items.at(-1);
  const body: GalleryPageBody = {
    images,
    ...(page.LastEvaluatedKey && last ? { nextCursor: last.imageId } : {}),
    ...(jobs ? { jobs } : {}),
  };
  return { status: 200, body: { ...body } };
}

/**
 * The caller's queued and running jobs, newest first. They come from the active-jobs index (tech design 4), which
 * holds only unfinished jobs, filtered to the caller.
 */
async function activeJobs(deps: ImagesDeps, sub: string): Promise<ActiveJobBody[]> {
  const statuses: ActiveJobStatus[] = ['queued', 'running'];
  const items: JobItem[] = [];
  for (const status of statuses) {
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const page = await deps.client.send(
        new QueryCommand({
          TableName: deps.tableName,
          IndexName: 'GSI1',
          KeyConditionExpression: 'GSI1PK = :status',
          FilterExpression: 'userId = :sub',
          ExpressionAttributeValues: { ':status': activeJobsGsiPk(status), ':sub': sub },
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );
      items.push(...((page.Items ?? []) as JobItem[]));
      exclusiveStartKey = page.LastEvaluatedKey;
    } while (exclusiveStartKey);
  }
  return items
    .filter((job) => job.status === 'queued' || job.status === 'running')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((job) => {
      const request = job.request;
      return {
        jobId: job.jobId,
        type: job.type,
        status: job.status as ActiveJobStatus,
        createdAt: job.createdAt,
        ...(request.type === 'edit'
          ? { text: request.instruction, count: 1, imageId: request.imageId }
          : { text: request.prompt, count: request.count }),
      };
    });
}

/**
 * `GET /api/images/:id/versions/:n/download` (GAL-3, GEN-7): a presigned URL that saves the version's original
 * PNG (`Content-Disposition: attachment`), or undefined when the caller has no such version.
 */
export async function versionDownloadUrl(
  deps: ImagesDeps,
  session: Session,
  imageId: string,
  version: string,
): Promise<string | undefined> {
  const number = Number(version);
  if (!ULID_PATTERN.test(imageId) || !/^[1-9][0-9]{0,5}$/.test(version)) return undefined;
  const item = (
    await deps.client.send(
      new GetCommand({
        TableName: deps.tableName,
        Key: { PK: userPk(session.sub), SK: versionSk(imageId, number) },
      }),
    )
  ).Item as VersionItem | undefined;
  if (!item?.s3Key.startsWith(`users/${session.sub}/`)) return undefined;
  return deps.presign(item.s3Key, imageFileName(imageId, number));
}

/**
 * `DELETE /api/images/:id` (GAL-3): deletes every object of the image (all its versions and thumbnails, gaps in
 * the numbering included), then its `IMG#` and `VER#` items. Objects go first, so a failure leaves the image in
 * the gallery to delete again. The objects are swept once more at the end, in case an edit that was running
 * stored its result in between; that edit then fails with a refund, because the image is gone (tech design 5.3).
 * Another user's image answers 404.
 */
export async function deleteImage(
  deps: ImageDeleteDeps,
  session: Session,
  imageId: string,
): Promise<ApiResult> {
  const notFound = apiError('not_found', 'Image not found.');
  if (!ULID_PATTERN.test(imageId)) return notFound;
  const pk = userPk(session.sub);
  const image = await readImage(deps, pk, imageId);
  if (!image) return notFound;

  const prefix = `users/${session.sub}/${imageId}/`;
  try {
    await deps.removePrefix(prefix);
    const versions = await queryVersions(deps, pk, imageId);
    const keys = [
      { PK: pk, SK: imageSk(imageId) },
      ...versions.map((item) => ({ PK: pk, SK: versionSk(imageId, item.version) })),
    ];
    for (let start = 0; start < keys.length; start += DELETE_BATCH) {
      await deleteBatch(deps, keys.slice(start, start + DELETE_BATCH));
    }
    await deps.removePrefix(prefix);
  } catch (error) {
    logError('Deleting an image failed', { imageId, error });
    return apiError('deletion_failed', "We couldn't delete your image. Please try again.");
  }
  return { status: 200, body: { imageId, deleted: true } };
}

async function deleteBatch(deps: ImagesDeps, keys: { PK: string; SK: string }[]): Promise<void> {
  let requests = keys.map((Key) => ({ DeleteRequest: { Key } }));
  for (let attempt = 1; requests.length > 0; attempt++) {
    if (attempt > MAX_BATCH_ATTEMPTS) {
      throw new Error(`${requests.length} items were still unprocessed after retries`);
    }
    const result = await deps.client.send(
      new BatchWriteCommand({ RequestItems: { [deps.tableName]: requests } }),
    );
    requests = (result.UnprocessedItems?.[deps.tableName] ?? []) as typeof requests;
    if (requests.length > 0) await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt));
  }
}

/** The settings a generated image was made with, to fill the generate screen for a rerun (GAL-3). */
export interface RerunSettings {
  prompt: string;
  enhancedPrompt?: string;
  avoid?: string;
  style?: StyleId;
  modelId?: string;
  quality?: Quality;
  aspect?: Aspect;
  seed?: number;
  transparentBackground?: boolean;
}

/**
 * The settings of the caller's generated image, from its version 1, for "Rerun" (GAL-3). Undefined for an
 * uploaded image, which has no prompt, and for an image the caller doesn't have.
 */
export async function rerunSettings(
  deps: ImagesDeps,
  session: Session,
  imageId: string,
): Promise<RerunSettings | undefined> {
  if (!ULID_PATTERN.test(imageId)) return undefined;
  const item = (
    await deps.client.send(
      new GetCommand({
        TableName: deps.tableName,
        Key: { PK: userPk(session.sub), SK: versionSk(imageId, 1) },
      }),
    )
  ).Item as VersionItem | undefined;
  if (!item?.prompt) return undefined;
  return {
    prompt: item.prompt,
    ...optional('enhancedPrompt', item.enhancedPrompt),
    ...optional('avoid', item.avoid),
    ...optional('style', item.style),
    ...optional('modelId', item.modelId),
    ...optional('quality', item.quality),
    ...optional('aspect', item.aspect),
    ...optional('seed', item.seed),
    ...optional('transparentBackground', item.transparentBackground),
  };
}

async function readImage(
  deps: ImagesDeps,
  pk: string,
  imageId: string,
): Promise<ImageItem | undefined> {
  const result = await deps.client.send(
    new GetCommand({ TableName: deps.tableName, Key: { PK: pk, SK: imageSk(imageId) } }),
  );
  return result.Item as ImageItem | undefined;
}

/** Every `VER#<imageId>#<n>` item of the image, sorted by number. */
async function queryVersions(
  deps: ImagesDeps,
  pk: string,
  imageId: string,
): Promise<VersionItem[]> {
  const items: VersionItem[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await deps.client.send(
      new QueryCommand({
        TableName: deps.tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        ExpressionAttributeValues: { ':pk': pk, ':prefix': `VER#${imageId}#` },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    items.push(...((page.Items ?? []) as VersionItem[]));
    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey);
  // Sort keys order `#10` before `#2`, so versions are sorted by number.
  return items.sort((a, b) => a.version - b.version);
}

function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}
