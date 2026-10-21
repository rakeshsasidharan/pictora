import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { imageSk, userPk } from '@pictora/core';
import { apiError, imageFileName, type ApiResult, type JobsDeps } from './jobs';
import type { Session } from './session';

/** What `GET /api/images/:id` needs: the table and presigned URLs, as the job API has them. */
export type ImagesDeps = Pick<JobsDeps, 'client' | 'tableName' | 'presign'>;

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

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
  /** `upload` for an uploaded version 1. */
  source?: 'upload';
  modelId?: string;
  quality?: string;
  aspect?: string;
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
  createdAt?: string;
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
  source?: 'upload';
  modelId?: string;
  quality?: string;
  aspect?: string;
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
  const image = (
    await deps.client.send(
      new GetCommand({ TableName: deps.tableName, Key: { PK: pk, SK: imageSk(imageId) } }),
    )
  ).Item as ImageItem | undefined;
  if (!image) return notFound;

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
  items.sort((a, b) => a.version - b.version);

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
          ...optional('source', item.source),
          ...optional('modelId', item.modelId),
          ...optional('quality', item.quality),
          ...optional('aspect', item.aspect),
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
      ...optional('createdAt', image.createdAt),
    },
    versions,
  };
  return { status: 200, body: { ...body } };
}

function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}
