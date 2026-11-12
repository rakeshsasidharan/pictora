import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import {
  BatchWriteCommand,
  DeleteCommand,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  MAX_ALT_TEXT_OVERRIDE_LENGTH,
  SEARCH_INDEX_VERSION,
  TOOL_NAMES,
  activeJobsGsiPk,
  altTextRequestSchema,
  autoTags,
  collectionGsiPk,
  collectionSk,
  imageSk,
  matchesTag,
  normaliseTag,
  rateLimitPerMinute,
  searchScore,
  searchTerms,
  searchWords,
  tagSk,
  toolIdFor,
  userPk,
  versionSk,
  type ActiveJobStatus,
  type Aspect,
  type GalleryFilter,
  type JobItem,
  type JobType,
  type Quality,
  type StyleId,
  type ToolId,
} from '@pictora/core';
import { recordDiscarded, recordDownload } from '@pictora/core/metrics-store';
import { takeRateSlot } from './enhance';
import { apiError, imageFileName, logError, type ApiResult, type JobsDeps } from './jobs';
import type { Session } from './session';

/**
 * What reading images needs: the table and presigned URLs, as the job API has them, and the registry's model
 * names, which automatic tags use (tech design 4.2).
 */
export type ImagesDeps = ImageReadDeps & {
  modelNames: () => Promise<Readonly<Record<string, string>>>;
};

/** What reading one version needs: the table and presigned URLs. */
export type ImageReadDeps = Pick<JobsDeps, 'client' | 'tableName' | 'presign'>;

/** What deleting an image needs on top: removing every object under an S3 prefix. */
export interface ImageDeleteDeps extends ImagesDeps {
  /** Deletes every object in the images bucket whose key starts with the prefix. */
  removePrefix: (prefix: string) => Promise<void>;
}

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const VERSION_PATTERN = /^[1-9][0-9]{0,5}$/;

/** Images per gallery page (GAL-1). */
export const GALLERY_PAGE_SIZE = 24;

/** The most images one `GET /api/images?limit=` page may ask for. */
export const GALLERY_MAX_LIMIT = 50;

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
  /** The image tool the version was made with, from its parent (tech design 5.5). */
  tool?: ToolId;
  /** The prompt the tool was given, for an upscale or outpaint. */
  toolPrompt?: string;
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
  /** The user's own alt text, set in the detail view; absent while the default (the prompt) is used. */
  altText?: string;
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
    /** The user's tags, in alphabetical order. */
    tags: string[];
    /** Tags from the style and model, which can't be removed (tech design 4.2). */
    autoTags: string[];
    /** The collection the image is in. */
    collection?: { collectionId: string; name: string };
  };
  /** Every version, oldest first. */
  versions: ImageVersionBody[];
}

/** An `IMG#<imageId>` item. */
export interface ImageItem {
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
  /** The user's tags, a string set (tech design 4.2). */
  tags?: Set<string>;
  /** The search words of the image's prompt, edits and tool prompts, a string set. */
  words?: Set<string>;
  /** `SEARCH_INDEX_VERSION` once `words` is up to date. */
  searchVersion?: number;
  /** The collection the image is in, mirrored in `GSI1PK` for the collection view. */
  collectionId?: string;
}

/** The user's tags of an image item, in alphabetical order. */
export function imageTags(item: Pick<ImageItem, 'tags'>): string[] {
  return [...(item.tags ?? [])].sort();
}

interface VersionItem {
  version: number;
  s3Key: string;
  thumbKey: string;
  width: number;
  height: number;
  parentVersion?: number;
  editInstruction?: string;
  /** The image tool that made it (tech design 5.5), and the prompt it was given. */
  tool?: ToolId;
  toolPrompt?: string;
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
  altText?: string;
  createdAt?: string;
  /** The job that made it; absent for an upload. */
  jobId?: string;
  /** Set the first time it is downloaded (tech design 11.1). */
  downloadedAt?: string;
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

  const [items, names, collection] = await Promise.all([
    queryVersions(deps, pk, imageId),
    deps.modelNames(),
    image.collectionId ? readCollection(deps, pk, image.collectionId) : undefined,
  ]);

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
          ...optional('tool', item.tool),
          ...optional('toolPrompt', item.toolPrompt),
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
          ...optional('altText', item.altText),
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
      tags: imageTags(image),
      autoTags: autoTags(image, names),
      ...(collection
        ? { collection: { collectionId: collection.collectionId, name: collection.name } }
        : {}),
    },
    versions,
  };
  return { status: 200, body: { ...body } };
}

/** A `COL#<collectionId>` item. */
export interface CollectionItem {
  collectionId: string;
  name: string;
  imageCount?: number;
  createdAt: string;
  updatedAt?: string;
}

/** The caller's collection, or undefined when they have none with that ID. */
export async function readCollection(
  deps: Pick<ImagesDeps, 'client' | 'tableName'>,
  pk: string,
  collectionId: string,
): Promise<CollectionItem | undefined> {
  const result = await deps.client.send(
    new GetCommand({ TableName: deps.tableName, Key: { PK: pk, SK: collectionSk(collectionId) } }),
  );
  return result.Item as CollectionItem | undefined;
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
  /** The user's tags, in alphabetical order (tech design 4.2). */
  tags: string[];
  /** The collection the image is in. */
  collectionId?: string;
}

/**
 * A job still queued or running, or a batch job still scheduled or submitted, shown as a placeholder at the top
 * of the gallery (GEN-8, tech design 5.4).
 */
export interface ActiveJobBody {
  jobId: string;
  type: JobType;
  status: ActiveJobStatus;
  createdAt: string;
  /** The prompt of a generate job, the instruction of an edit, or the name of an image tool. */
  text: string;
  /** How many images the job makes. */
  count: number;
  /** The image an edit or a tool adds a version to. */
  imageId?: string;
  /** `batch` for a job delivered later through a provider batch. */
  delivery?: 'batch';
}

/** The `GET /api/images` body. */
export interface GalleryPageBody {
  /** Newest first; best match first for a search. */
  images: GalleryImageBody[];
  /** Pass as `?cursor=` for the next page; absent on the last page. */
  nextCursor?: string;
  /** The caller's queued and running jobs, newest first; on the first page of the whole gallery only. */
  jobs?: ActiveJobBody[];
  /** How many images match, for a search or a tag filter. */
  total?: number;
}

// A search or tag filter pages by position in the ranked results.
const OFFSET_PATTERN = /^(0|[1-9][0-9]{0,5})$/;

/** Images whose search words are rebuilt at once, when a search finds images made before search existed. */
const INDEX_CONCURRENCY = 8;

/**
 * `GET /api/images?cursor=&limit=&q=&tag=&collection=` (GAL-1, GEN-8, tech design 4.2): a page of the caller's
 * images, each with a presigned thumbnail. A page holds `limit` images (24 unless the caller asks for 1 to 50;
 * the route checks the range and the filters).
 *
 * - Without filters, the whole gallery, newest first; the cursor is the ID of the last image on the previous
 *   page, and the first page also lists the caller's jobs that are still queued or running.
 * - With only `collection`, that collection's images, newest first, read from GSI1 with the same cursor.
 * - With `q` or `tag`, every candidate (the collection's images, or the whole gallery) is read and matched here:
 *   `tag` must be one of the image's tags or automatic tags, and every word of `q` must match. Results are
 *   ranked (`searchScore`), newest first among equals, and the cursor is the position of the next page.
 *
 * A collection the caller doesn't have answers 404.
 */
export async function listImages(
  deps: ImagesDeps,
  session: Session,
  cursor?: string | null,
  limit: number = GALLERY_PAGE_SIZE,
  filter: GalleryFilter = {},
): Promise<ApiResult> {
  const terms = filter.q ? searchTerms(filter.q) : [];
  const tag = filter.tag ? normaliseTag(filter.tag) : '';
  const matching = terms.length > 0 || tag !== '';
  if (cursor && !(matching ? OFFSET_PATTERN : ULID_PATTERN).test(cursor)) {
    return apiError('invalid_request', 'That page of the gallery is not valid.');
  }
  const pk = userPk(session.sub);
  if (filter.collection && !(await readCollection(deps, pk, filter.collection))) {
    return apiError('not_found', 'Collection not found.');
  }
  if (matching) {
    return matchImages(
      deps,
      session,
      { terms, tag, collectionId: filter.collection },
      cursor,
      limit,
    );
  }

  const query = filter.collection
    ? new QueryCommand({
        TableName: deps.tableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :collection',
        ExpressionAttributeValues: {
          ':collection': collectionGsiPk(session.sub, filter.collection),
        },
        ScanIndexForward: false,
        Limit: limit,
        ...(cursor
          ? {
              ExclusiveStartKey: {
                GSI1PK: collectionGsiPk(session.sub, filter.collection),
                GSI1SK: cursor,
                PK: pk,
                SK: imageSk(cursor),
              },
            }
          : {}),
      })
    : new QueryCommand({
        TableName: deps.tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        ExpressionAttributeValues: { ':pk': pk, ':prefix': 'IMG#' },
        ScanIndexForward: false,
        Limit: limit,
        ...(cursor ? { ExclusiveStartKey: { PK: pk, SK: imageSk(cursor) } } : {}),
      });
  const showJobs = !cursor && !filter.collection;
  const [page, jobs] = await Promise.all([
    deps.client.send(query),
    showJobs ? activeJobs(deps, session.sub) : Promise.resolve(undefined),
  ]);
  const items = (page.Items ?? []) as ImageItem[];
  const last = items.at(-1);
  const body: GalleryPageBody = {
    images: await galleryImages(deps, session, items),
    ...(page.LastEvaluatedKey && last ? { nextCursor: last.imageId } : {}),
    ...(jobs ? { jobs } : {}),
  };
  return { status: 200, body: { ...body } };
}

/** The grid tiles of image items; only the owner's own objects are ever presigned. */
async function galleryImages(
  deps: ImagesDeps,
  session: Session,
  items: ImageItem[],
): Promise<GalleryImageBody[]> {
  const prefix = `users/${session.sub}/`;
  return Promise.all(
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
        tags: imageTags(item),
        ...optional('collectionId', item.collectionId),
      })),
  );
}

/** A search or tag filter of `listImages`. */
interface Match {
  terms: string[];
  /** A normalised tag, or empty for none. */
  tag: string;
  collectionId?: string;
}

/** The ranked results of a search or tag filter, one page of them at a time. */
async function matchImages(
  deps: ImagesDeps,
  session: Session,
  match: Match,
  cursor: string | null | undefined,
  limit: number,
): Promise<ApiResult> {
  const pk = userPk(session.sub);
  const [candidates, names] = await Promise.all([
    match.collectionId
      ? queryAll(deps, {
          IndexName: 'GSI1',
          KeyConditionExpression: 'GSI1PK = :collection',
          ExpressionAttributeValues: {
            ':collection': collectionGsiPk(session.sub, match.collectionId),
          },
        })
      : queryAll(deps, {
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
          ExpressionAttributeValues: { ':pk': pk, ':prefix': 'IMG#' },
        }),
    deps.modelNames(),
  ]);
  const items = candidates as unknown as ImageItem[];
  if (match.terms.length > 0) await indexImages(deps, pk, items);

  const ranked = items
    .flatMap((item) => {
      const tags = imageTags(item);
      const auto = autoTags(item, names);
      if (match.tag && !matchesTag(match.tag, tags, auto)) return [];
      const score = searchScore(match.terms, {
        words: [...(item.words ?? [])],
        tags,
        autoTags: auto,
      });
      return score === undefined ? [] : [{ item, score }];
    })
    .sort((a, b) => b.score - a.score || (a.item.imageId < b.item.imageId ? 1 : -1));

  const offset = cursor ? Number(cursor) : 0;
  const next = offset + limit;
  const body: GalleryPageBody = {
    images: await galleryImages(
      deps,
      session,
      ranked.slice(offset, next).map(({ item }) => item),
    ),
    ...(next < ranked.length ? { nextCursor: String(next) } : {}),
    total: ranked.length,
  };
  return { status: 200, body: { ...body } };
}

/** Every item a query finds, across all its pages. */
export async function queryAll(
  deps: Pick<ImagesDeps, 'client' | 'tableName'>,
  input: Omit<ConstructorParameters<typeof QueryCommand>[0], 'TableName' | 'ExclusiveStartKey'>,
): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await deps.client.send(
      new QueryCommand({
        ...input,
        TableName: deps.tableName,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    items.push(...(page.Items ?? []));
    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return items;
}

/**
 * Builds the search words of images made before search existed (no `searchVersion`, or an older one) from their
 * versions, and stores them. The write is conditional on the version count read, so an edit that finished in
 * between isn't lost: that image is indexed again by a later search. The words are used for this search either
 * way. A failed write is logged, never thrown.
 */
async function indexImages(deps: ImagesDeps, pk: string, items: ImageItem[]): Promise<void> {
  const stale = items.filter((item) => item.searchVersion !== SEARCH_INDEX_VERSION);
  for (let start = 0; start < stale.length; start += INDEX_CONCURRENCY) {
    await Promise.all(
      stale.slice(start, start + INDEX_CONCURRENCY).map(async (item) => {
        const versions = await queryVersions(deps, pk, item.imageId);
        const words = searchWords(
          ...versions.flatMap((version) => [
            version.prompt,
            version.editInstruction,
            version.toolPrompt,
          ]),
        );
        item.words = new Set(words);
        try {
          await deps.client.send(
            new UpdateCommand({
              TableName: deps.tableName,
              Key: { PK: pk, SK: imageSk(item.imageId) },
              UpdateExpression:
                words.length > 0
                  ? 'SET searchVersion = :version, words = :words'
                  : 'SET searchVersion = :version REMOVE words',
              ConditionExpression: 'attribute_exists(PK) AND versionCount = :count',
              ExpressionAttributeValues: {
                ':version': SEARCH_INDEX_VERSION,
                ':count': item.versionCount,
                ...(words.length > 0 ? { ':words': item.words } : {}),
              },
            }),
          );
        } catch (error) {
          if (error instanceof ConditionalCheckFailedException) return;
          logError('Indexing an image for search failed', { imageId: item.imageId, error });
        }
      }),
    );
  }
}

/**
 * The caller's queued, running and batch jobs, newest first. They come from the active-jobs index (tech design 4), which
 * holds only unfinished jobs, filtered to the caller.
 */
async function activeJobs(deps: ImagesDeps, sub: string): Promise<ActiveJobBody[]> {
  const statuses: ActiveJobStatus[] = ['queued', 'running', 'scheduled', 'submitted'];
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
    .filter((job) => statuses.includes(job.status as ActiveJobStatus))
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
          : request.type === 'tool'
            ? { text: TOOL_NAMES[toolIdFor(request)], count: 1, imageId: request.imageId }
            : {
                text: request.prompt,
                count: request.count,
                ...(request.delivery === 'batch' ? { delivery: 'batch' as const } : {}),
              }),
      };
    });
}

/**
 * `GET /api/images/:id/versions/:n/download` (GAL-3, GEN-7): a presigned URL that saves the version's original
 * PNG (`Content-Disposition: attachment`), or undefined when the caller has no such version. The first download
 * of a generated version counts as `image_downloaded` for the keep rate (tech design 11.1).
 */
export async function versionDownloadUrl(
  deps: ImageReadDeps,
  session: Session,
  imageId: string,
  version: string,
): Promise<string | undefined> {
  const number = Number(version);
  if (!ULID_PATTERN.test(imageId) || !VERSION_PATTERN.test(version)) return undefined;
  const item = (
    await deps.client.send(
      new GetCommand({
        TableName: deps.tableName,
        Key: { PK: userPk(session.sub), SK: versionSk(imageId, number) },
      }),
    )
  ).Item as VersionItem | undefined;
  if (!item?.s3Key.startsWith(`users/${session.sub}/`)) return undefined;
  if (item.jobId && !item.downloadedAt) {
    try {
      await recordDownload(deps, session.sub, imageId, number, new Date());
    } catch (error) {
      logError('Counting a download failed', { imageId, error });
    }
  }
  return deps.presign(item.s3Key, imageFileName(imageId, number));
}

/** The `PATCH /api/images/:id/versions/:n` body: the version's alt text, or null when the default is used. */
export interface VersionAltTextBody {
  imageId: string;
  version: number;
  altText: string | null;
}

/**
 * `PATCH /api/images/:id/versions/:n` (WCAG 2.2 AA, #30): sets the user's own alt text on one of their versions,
 * or removes it (`null`) so the prompt or edit instruction is used again. Counts in the minute's rate window
 * with jobs (429). Another user's version answers 404, the same as one that doesn't exist.
 */
export async function setVersionAltText(
  deps: ImageReadDeps,
  session: Session,
  imageId: string,
  version: string,
  input: unknown,
  now: Date = new Date(),
): Promise<ApiResult> {
  const notFound = apiError('not_found', 'Image not found.');
  if (!ULID_PATTERN.test(imageId) || !VERSION_PATTERN.test(version)) return notFound;
  const parsed = altTextRequestSchema.safeParse(input);
  if (!parsed.success) {
    return apiError(
      'invalid_request',
      `Alt text must be 1 to ${MAX_ALT_TEXT_OVERRIDE_LENGTH} characters.`,
    );
  }
  const rateLimit = rateLimitPerMinute(session.groups);
  if (!(await takeRateSlot(deps.client, deps.tableName, session.sub, now, rateLimit))) {
    return apiError(
      'rate_limited',
      `You've made ${rateLimit} requests in the last minute. Wait a moment, then try again.`,
    );
  }
  const { altText } = parsed.data;
  const number = Number(version);
  try {
    await deps.client.send(
      new UpdateCommand({
        TableName: deps.tableName,
        Key: { PK: userPk(session.sub), SK: versionSk(imageId, number) },
        ConditionExpression: 'attribute_exists(PK)',
        ...(altText === null
          ? { UpdateExpression: 'REMOVE altText' }
          : {
              UpdateExpression: 'SET altText = :altText',
              ExpressionAttributeValues: { ':altText': altText },
            }),
      }),
    );
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) return notFound;
    throw error;
  }
  const body: VersionAltTextBody = { imageId, version: number, altText };
  return { status: 200, body: { ...body } };
}

/**
 * `DELETE /api/images/:id` (GAL-3): deletes every object of the image (all its versions and thumbnails, gaps in
 * the numbering included), then its `IMG#` item (with one less image in its collection and on each tag, tech
 * design 4.2) and its `VER#` items. Objects go first, so a failure leaves the image in the gallery to delete again. The objects are swept once more at the end, in case an edit that was running
 * stored its result in between; that edit then fails with a refund, because the image is gone (tech design 5.3).
 * Another user's image answers 404. Generated versions deleted unkept count against the keep rate.
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
    await deleteImageItem(deps, pk, image);
    const keys = versions.map((item) => ({ PK: pk, SK: versionSk(imageId, item.version) }));
    for (let start = 0; start < keys.length; start += DELETE_BATCH) {
      await deleteBatch(deps, keys.slice(start, start + DELETE_BATCH));
    }
    await deps.removePrefix(prefix);
    await removeUnusedTags(deps, pk, imageTags(image));
    await countDiscarded(deps, imageId, versions);
  } catch (error) {
    logError('Deleting an image failed', { imageId, error });
    return apiError('deletion_failed', "We couldn't delete your image. Please try again.");
  }
  return { status: 200, body: { imageId, deleted: true } };
}

/** One item of a `TransactWriteItems` call. */
export type TransactItem = NonNullable<
  ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']
>[number];

/**
 * Runs a transaction whose `counters` items (a collection's or tag's image count) are each conditional on the
 * item existing. A counter whose item has gone, because its collection was deleted in the meantime, is dropped
 * and the rest tried again, so a count never brings back a deleted item and never blocks the change it counts.
 * A failed condition on one of the `required` items is thrown as `TransactionCanceledException`.
 */
export async function transactWithCounters(
  deps: Pick<ImagesDeps, 'client'>,
  required: TransactItem[],
  counters: TransactItem[],
): Promise<void> {
  let optional = counters;
  for (;;) {
    try {
      await deps.client.send(
        new TransactWriteCommand({ TransactItems: [...required, ...optional] }),
      );
      return;
    } catch (error) {
      if (!(error instanceof TransactionCanceledException)) throw error;
      const reasons = error.CancellationReasons ?? [];
      const failed = (index: number) => reasons[index]?.Code === 'ConditionalCheckFailed';
      if (required.some((_, index) => failed(index))) throw error;
      const kept = optional.filter((_, index) => !failed(required.length + index));
      if (kept.length === optional.length) throw error;
      optional = kept;
    }
  }
}

/** Adds `delta` to a collection's or tag's `imageCount`, only while its item exists. */
export function counterUpdate(
  tableName: string,
  key: { PK: string; SK: string },
  delta: number,
): TransactItem {
  return {
    Update: {
      TableName: tableName,
      Key: key,
      UpdateExpression: 'ADD imageCount :delta',
      ConditionExpression: 'attribute_exists(PK)',
      ExpressionAttributeValues: { ':delta': delta },
    },
  };
}

/**
 * Deletes the `IMG#` item, with one less image in its collection and on each of its tags (tech design 4.2). An
 * image already gone counts as deleted.
 */
async function deleteImageItem(deps: ImagesDeps, pk: string, image: ImageItem): Promise<void> {
  const counters = [
    ...(image.collectionId
      ? [counterUpdate(deps.tableName, { PK: pk, SK: collectionSk(image.collectionId) }, -1)]
      : []),
    ...imageTags(image).map((tag) => counterUpdate(deps.tableName, { PK: pk, SK: tagSk(tag) }, -1)),
  ];
  try {
    await transactWithCounters(
      deps,
      [
        {
          Delete: {
            TableName: deps.tableName,
            Key: { PK: pk, SK: imageSk(image.imageId) },
            ConditionExpression: 'attribute_exists(PK)',
          },
        },
      ],
      counters,
    );
  } catch (error) {
    // Deleted at the same time by another request, which counted it.
    if (error instanceof TransactionCanceledException) return;
    throw error;
  }
}

/**
 * Deletes the `TAG#` items of these tags that no image uses any more, so suggestions and the tag filter only
 * offer tags in use. Logged, never thrown: the change that freed them is already made.
 */
export async function removeUnusedTags(
  deps: Pick<ImagesDeps, 'client' | 'tableName'>,
  pk: string,
  tags: string[],
): Promise<void> {
  await Promise.all(
    tags.map(async (tag) => {
      try {
        await deps.client.send(
          new DeleteCommand({
            TableName: deps.tableName,
            Key: { PK: pk, SK: tagSk(tag) },
            ConditionExpression: 'imageCount <= :zero',
            ExpressionAttributeValues: { ':zero': 0 },
          }),
        );
      } catch (error) {
        if (error instanceof ConditionalCheckFailedException) return;
        logError('Removing an unused tag failed', { tag, error });
      }
    }),
  );
}

/**
 * Generated versions deleted within 7 days without a download weren't kept (tech design 11.1). Logged, never
 * thrown: the image is already gone.
 */
async function countDiscarded(
  deps: ImagesDeps,
  imageId: string,
  versions: VersionItem[],
): Promise<void> {
  try {
    await recordDiscarded(deps, versions, new Date());
  } catch (error) {
    logError('Counting a deleted image failed', { imageId, error });
  }
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
  deps: ImageReadDeps,
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

export async function readImage(
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
