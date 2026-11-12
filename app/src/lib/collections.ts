import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import { QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  MAX_COLLECTIONS,
  MAX_TAGS_PER_IMAGE,
  PROFILE_SK,
  bulkRequestSchema,
  collectionGsiPk,
  collectionNameKey,
  collectionNameSk,
  collectionRequestSchema,
  collectionSk,
  imageSk,
  rateLimitPerMinute,
  tagSk,
  userPk,
  type BulkRequest,
} from '@pictora/core';
import { ulid } from 'ulid';
import { takeRateSlot } from './enhance';
import {
  counterUpdate,
  deleteImage,
  imageTags,
  queryAll,
  readCollection,
  readImage,
  removeUnusedTags,
  transactWithCounters,
  type CollectionItem,
  type ImageDeleteDeps,
  type ImageItem,
  type TransactItem,
} from './images';
import { apiError, logError, type ApiResult } from './jobs';
import type { Session } from './session';

/** What the collection and tag APIs need: the table, and for a bulk delete, the image API's own deps. */
export type CollectionsDeps = ImageDeleteDeps & {
  now?: () => Date;
  newId?: () => string;
};

/** One collection, as the gallery lists it. */
export interface CollectionBody {
  collectionId: string;
  name: string;
  imageCount: number;
  createdAt: string;
}

/** The `GET /api/collections` body: the caller's collections by name. */
export interface CollectionsBody {
  collections: CollectionBody[];
}

/** One of the caller's tags, with how many images carry it. */
export interface TagBody {
  tag: string;
  imageCount: number;
}

/** The `GET /api/tags` body: the caller's tags, most used first. */
export interface TagsBody {
  tags: TagBody[];
}

/** How one image of a bulk request went. */
export type BulkResult =
  { imageId: string; ok: true } | { imageId: string; ok: false; code: BulkFailure; error: string };

/** Why one image of a bulk request was left as it was. */
export type BulkFailure = 'not_found' | 'too_many_tags' | 'failed';

/** The `POST /api/images/bulk` body. */
export interface BulkBody {
  results: BulkResult[];
}

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Images updated at once by a bulk request, or unfiled at once when their collection is deleted. */
const WRITE_CONCURRENCY = 8;

/** Bulk deletes run fewer at a time: each removes S3 objects too. */
const DELETE_CONCURRENCY = 4;

/** How many times a change to an image is tried when another request changed it first. */
const MAX_ATTEMPTS = 3;

const BULK_ERRORS: Record<BulkFailure, string> = {
  not_found: 'Image not found.',
  too_many_tags: `An image can have at most ${MAX_TAGS_PER_IMAGE} tags.`,
  failed: "We couldn't change this image. Please try again.",
};

const notFound = () => apiError('not_found', 'Collection not found.');
const nameTaken = () => apiError('name_taken', 'You already have a collection with that name.');

function collectionBody(item: CollectionItem): CollectionBody {
  return {
    collectionId: item.collectionId,
    name: item.name,
    imageCount: Math.max(0, item.imageCount ?? 0),
    createdAt: item.createdAt,
  };
}

/** Takes a slot in the minute's rate window, or answers 429. */
async function rateLimited(
  deps: CollectionsDeps,
  session: Session,
  now: Date,
): Promise<ApiResult | undefined> {
  const limit = rateLimitPerMinute(session.groups);
  if (await takeRateSlot(deps.client, deps.tableName, session.sub, now, limit)) return undefined;
  return apiError(
    'rate_limited',
    `You've made ${limit} requests in the last minute. Wait a moment, then try again.`,
  );
}

/** The transaction item that refuses a write once the account is being deleted (AUTH-3), always the first. */
function profileCheck(tableName: string, pk: string): TransactItem {
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: { PK: pk, SK: PROFILE_SK },
      ConditionExpression: 'attribute_exists(PK) AND #status <> :deleting',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':deleting': 'deleting' },
    },
  };
}

/** The first failed condition of a cancelled transaction, by item position. */
function failedAt(error: TransactionCanceledException): number {
  return (error.CancellationReasons ?? []).findIndex(
    (reason) => reason.Code === 'ConditionalCheckFailed',
  );
}

async function collectionItems(deps: CollectionsDeps, pk: string): Promise<CollectionItem[]> {
  return (await queryAll(deps, {
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': pk, ':prefix': 'COL#' },
  })) as unknown as CollectionItem[];
}

/** `GET /api/collections` (tech design 4.2): the caller's collections, by name. */
export async function listCollections(deps: CollectionsDeps, session: Session): Promise<ApiResult> {
  const items = await collectionItems(deps, userPk(session.sub));
  const body: CollectionsBody = {
    collections: items
      .map(collectionBody)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
  };
  return { status: 200, body: { ...body } };
}

/**
 * `POST /api/collections`: a new, empty collection. Names are unique per user, ignoring case (a `COLNAME#`
 * item claims each), and a user has at most `MAX_COLLECTIONS`. Counts in the rate window.
 */
export async function createCollection(
  deps: CollectionsDeps,
  session: Session,
  input: unknown,
): Promise<ApiResult> {
  const parsed = collectionRequestSchema.safeParse(input);
  if (!parsed.success) {
    return apiError('invalid_request', parsed.error.issues[0]?.message ?? 'Enter a name.');
  }
  const now = deps.now?.() ?? new Date();
  const limited = await rateLimited(deps, session, now);
  if (limited) return limited;

  const pk = userPk(session.sub);
  const existing = await deps.client.send(
    new QueryCommand({
      TableName: deps.tableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': pk, ':prefix': 'COL#' },
      Select: 'COUNT',
    }),
  );
  if ((existing.Count ?? 0) >= MAX_COLLECTIONS) {
    return apiError('limit_reached', `You can have at most ${MAX_COLLECTIONS} collections.`);
  }

  const { name } = parsed.data;
  const at = now.toISOString();
  const item: CollectionItem = {
    collectionId: deps.newId?.() ?? ulid(),
    name,
    imageCount: 0,
    createdAt: at,
    updatedAt: at,
  };
  try {
    await deps.client.send(
      new TransactWriteCommand({
        TransactItems: [
          profileCheck(deps.tableName, pk),
          {
            Put: {
              TableName: deps.tableName,
              Item: { PK: pk, SK: collectionNameSk(name), collectionId: item.collectionId },
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          {
            Put: {
              TableName: deps.tableName,
              Item: { PK: pk, SK: collectionSk(item.collectionId), ...item },
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
        ],
      }),
    );
  } catch (error) {
    if (error instanceof TransactionCanceledException) {
      const at = failedAt(error);
      if (at === 0) return apiError('account_deleting', 'Your account is being deleted.');
      if (at === 1) return nameTaken();
    }
    throw error;
  }
  return { status: 201, body: { collection: collectionBody(item) } };
}

/**
 * `PATCH /api/collections/:id`: renames the caller's collection, moving its `COLNAME#` claim to the new name.
 * A change of case alone keeps the claim. Counts in the rate window.
 */
export async function renameCollection(
  deps: CollectionsDeps,
  session: Session,
  collectionId: string,
  input: unknown,
): Promise<ApiResult> {
  if (!ULID_PATTERN.test(collectionId)) return notFound();
  const parsed = collectionRequestSchema.safeParse(input);
  if (!parsed.success) {
    return apiError('invalid_request', parsed.error.issues[0]?.message ?? 'Enter a name.');
  }
  const now = deps.now?.() ?? new Date();
  const limited = await rateLimited(deps, session, now);
  if (limited) return limited;

  const pk = userPk(session.sub);
  const current = await readCollection(deps, pk, collectionId);
  if (!current) return notFound();
  const { name } = parsed.data;
  const at = now.toISOString();
  const rename: TransactItem = {
    Update: {
      TableName: deps.tableName,
      Key: { PK: pk, SK: collectionSk(collectionId) },
      UpdateExpression: 'SET #name = :name, updatedAt = :now',
      ConditionExpression: 'attribute_exists(PK) AND #name = :old',
      ExpressionAttributeNames: { '#name': 'name' },
      ExpressionAttributeValues: { ':name': name, ':old': current.name, ':now': at },
    },
  };
  const sameKey = collectionNameKey(name) === collectionNameKey(current.name);
  const claims: TransactItem[] = sameKey
    ? []
    : [
        {
          Put: {
            TableName: deps.tableName,
            Item: { PK: pk, SK: collectionNameSk(name), collectionId },
            ConditionExpression: 'attribute_not_exists(PK)',
          },
        },
        {
          Delete: {
            TableName: deps.tableName,
            Key: { PK: pk, SK: collectionNameSk(current.name) },
            ConditionExpression: 'collectionId = :id',
            ExpressionAttributeValues: { ':id': collectionId },
          },
        },
      ];
  try {
    await deps.client.send(new TransactWriteCommand({ TransactItems: [rename, ...claims] }));
  } catch (error) {
    if (error instanceof TransactionCanceledException) {
      const failed = failedAt(error);
      if (failed === 1) return nameTaken();
      // Renamed or deleted by another request in the meantime.
      if (failed === 0 || failed === 2) {
        return (await readCollection(deps, pk, collectionId))
          ? apiError('invalid_state', 'This collection just changed. Please try again.')
          : notFound();
      }
    }
    throw error;
  }
  const body = collectionBody({ ...current, name });
  return { status: 200, body: { collection: body } };
}

/**
 * `DELETE /api/collections/:id`: deletes the caller's collection. Its images stay in the gallery, outside any
 * collection: each is unfiled first, then the collection and its name claim go, then the images are swept once
 * more for any moved in while it ran. Counts in the rate window.
 */
export async function deleteCollection(
  deps: CollectionsDeps,
  session: Session,
  collectionId: string,
): Promise<ApiResult> {
  if (!ULID_PATTERN.test(collectionId)) return notFound();
  const now = deps.now?.() ?? new Date();
  const limited = await rateLimited(deps, session, now);
  if (limited) return limited;

  const pk = userPk(session.sub);
  const collection = await readCollection(deps, pk, collectionId);
  if (!collection) return notFound();
  try {
    let unfiled = await unfileImages(deps, session, collectionId);
    await deps.client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Delete: { TableName: deps.tableName, Key: { PK: pk, SK: collectionSk(collectionId) } },
          },
          {
            Delete: {
              TableName: deps.tableName,
              Key: { PK: pk, SK: collectionNameSk(collection.name) },
            },
          },
        ],
      }),
    );
    unfiled += await unfileImages(deps, session, collectionId);
    return { status: 200, body: { collectionId, deleted: true, imagesUnfiled: unfiled } };
  } catch (error) {
    logError('Deleting a collection failed', { collectionId, error });
    return apiError('deletion_failed', "We couldn't delete this collection. Please try again.");
  }
}

/** Takes every image out of the collection; returns how many it changed. */
async function unfileImages(
  deps: CollectionsDeps,
  session: Session,
  collectionId: string,
): Promise<number> {
  const pk = userPk(session.sub);
  const members = await queryAll(deps, {
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :collection',
    ExpressionAttributeValues: { ':collection': collectionGsiPk(session.sub, collectionId) },
  });
  let changed = 0;
  for (let start = 0; start < members.length; start += WRITE_CONCURRENCY) {
    const done = await Promise.all(
      members.slice(start, start + WRITE_CONCURRENCY).map(async (member) => {
        try {
          await deps.client.send(
            new UpdateCommand({
              TableName: deps.tableName,
              Key: { PK: pk, SK: imageSk(member.imageId as string) },
              UpdateExpression: 'REMOVE collectionId, GSI1PK, GSI1SK',
              ConditionExpression: 'collectionId = :id',
              ExpressionAttributeValues: { ':id': collectionId },
            }),
          );
          return true;
        } catch (error) {
          // Moved elsewhere or deleted in the meantime.
          if (error instanceof ConditionalCheckFailedException) return false;
          throw error;
        }
      }),
    );
    changed += done.filter(Boolean).length;
  }
  return changed;
}

/** `GET /api/tags` (tech design 4.2): the caller's tags in use, most used first, then by name. */
export async function listTags(deps: CollectionsDeps, session: Session): Promise<ApiResult> {
  const items = await queryAll(deps, {
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': userPk(session.sub), ':prefix': 'TAG#' },
  });
  const body: TagsBody = {
    tags: items
      .map((item) => ({ tag: item.tag as string, imageCount: Number(item.imageCount ?? 0) }))
      .filter((tag) => tag.imageCount > 0)
      .sort((a, b) => b.imageCount - a.imageCount || a.tag.localeCompare(b.tag)),
  };
  return { status: 200, body: { ...body } };
}

/**
 * `POST /api/images/bulk` (tech design 4.2): moves up to `MAX_BULK_IMAGES` of the caller's images to a collection
 * (or out of theirs), adds or removes a tag, or deletes them. Each image is changed on its own and reported in
 * `results`; an image the caller doesn't have is `not_found` there. A collection the caller doesn't have answers
 * 404 before anything changes. The request takes one slot in the rate window.
 */
export async function bulkUpdate(
  deps: CollectionsDeps,
  session: Session,
  input: unknown,
): Promise<ApiResult> {
  const parsed = bulkRequestSchema.safeParse(input);
  if (!parsed.success) {
    return apiError(
      'invalid_request',
      parsed.error.issues[0]?.message ?? 'That change to your images is not valid.',
    );
  }
  const request = parsed.data;
  const now = deps.now?.() ?? new Date();
  const limited = await rateLimited(deps, session, now);
  if (limited) return limited;

  const pk = userPk(session.sub);
  if (request.action === 'move' && request.collectionId) {
    if (!(await readCollection(deps, pk, request.collectionId))) return notFound();
  }

  const concurrency = request.action === 'delete' ? DELETE_CONCURRENCY : WRITE_CONCURRENCY;
  const results: BulkResult[] = [];
  for (let start = 0; start < request.imageIds.length; start += concurrency) {
    const batch = request.imageIds.slice(start, start + concurrency);
    results.push(
      ...(await Promise.all(
        batch.map(async (imageId): Promise<BulkResult> => {
          let outcome: BulkFailure | undefined;
          try {
            outcome = await changeImage(deps, session, request, imageId);
          } catch (error) {
            logError('A bulk change to an image failed', {
              action: request.action,
              imageId,
              error,
            });
            outcome = 'failed';
          }
          return outcome
            ? { imageId, ok: false, code: outcome, error: BULK_ERRORS[outcome] }
            : { imageId, ok: true };
        }),
      )),
    );
  }
  if (request.action === 'removeTag') await removeUnusedTags(deps, pk, [request.tag]);
  const body: BulkBody = { results };
  return { status: 200, body: { ...body } };
}

/** Applies a bulk request to one image; undefined when it's done (or there was nothing to do). */
async function changeImage(
  deps: CollectionsDeps,
  session: Session,
  request: BulkRequest,
  imageId: string,
): Promise<BulkFailure | undefined> {
  if (request.action === 'delete') {
    const result = await deleteImage(deps, session, imageId);
    if (result.status === 404) return 'not_found';
    return result.status === 200 ? undefined : 'failed';
  }
  const pk = userPk(session.sub);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const image = await readImage(deps, pk, imageId);
    if (!image) return 'not_found';
    try {
      if (request.action === 'move') {
        await moveImage(deps, session, image, request.collectionId);
      } else if (request.action === 'addTag') {
        const tags = imageTags(image);
        if (tags.includes(request.tag)) return undefined;
        if (tags.length >= MAX_TAGS_PER_IMAGE) return 'too_many_tags';
        await addTag(deps, pk, image, request.tag);
      } else {
        if (!imageTags(image).includes(request.tag)) return undefined;
        await removeTag(deps, pk, image, request.tag);
      }
      return undefined;
    } catch (error) {
      // Another request changed the image (or the profile) first: read it again and retry.
      if (!(error instanceof TransactionCanceledException)) throw error;
      // The account is being deleted, or the target collection was deleted: nothing to retry.
      if (request.action === 'addTag' && failedAt(error) === 0) return 'failed';
      if (request.action === 'move' && failedAt(error) === 1) return 'failed';
    }
  }
  return 'failed';
}

/**
 * Moves the image into the collection, or out of its own (`null`), with the collection counts moved in the same
 * transaction. The image's `GSI1PK` and `GSI1SK` put it in the collection's view, newest first.
 */
async function moveImage(
  deps: CollectionsDeps,
  session: Session,
  image: ImageItem,
  collectionId: string | null,
): Promise<void> {
  const from = image.collectionId;
  if ((from ?? null) === collectionId) return;
  const pk = userPk(session.sub);
  const condition = from
    ? 'attribute_exists(PK) AND collectionId = :from'
    : 'attribute_exists(PK) AND attribute_not_exists(collectionId)';
  const fromValue = from ? { ':from': from } : {};
  const update: TransactItem = {
    Update: {
      TableName: deps.tableName,
      Key: { PK: pk, SK: imageSk(image.imageId) },
      ...(collectionId
        ? {
            UpdateExpression: 'SET collectionId = :to, GSI1PK = :gsiPk, GSI1SK = :imageId',
            ExpressionAttributeValues: {
              ':to': collectionId,
              ':gsiPk': collectionGsiPk(session.sub, collectionId),
              ':imageId': image.imageId,
              ...fromValue,
            },
          }
        : {
            UpdateExpression: 'REMOVE collectionId, GSI1PK, GSI1SK',
            ...(from ? { ExpressionAttributeValues: fromValue } : {}),
          }),
      ConditionExpression: condition,
    },
  };
  // The target collection must still exist; the one it leaves may have just been deleted.
  const required: TransactItem[] = [
    update,
    ...(collectionId
      ? [counterUpdate(deps.tableName, { PK: pk, SK: collectionSk(collectionId) }, 1)]
      : []),
  ];
  const counters = from
    ? [counterUpdate(deps.tableName, { PK: pk, SK: collectionSk(from) }, -1)]
    : [];
  await transactWithCounters(deps, required, counters);
}

/**
 * Adds the tag to the image and counts it on its `TAG#` item (made when it's the first image with the tag), as
 * long as the account isn't being deleted.
 */
async function addTag(
  deps: CollectionsDeps,
  pk: string,
  image: ImageItem,
  tag: string,
): Promise<void> {
  await deps.client.send(
    new TransactWriteCommand({
      TransactItems: [
        profileCheck(deps.tableName, pk),
        {
          Update: {
            TableName: deps.tableName,
            Key: { PK: pk, SK: imageSk(image.imageId) },
            UpdateExpression: 'ADD tags :tags',
            ConditionExpression:
              'attribute_exists(PK) AND (attribute_not_exists(tags) OR (NOT contains(tags, :tag) AND size(tags) < :max))',
            ExpressionAttributeValues: {
              ':tags': new Set([tag]),
              ':tag': tag,
              ':max': MAX_TAGS_PER_IMAGE,
            },
          },
        },
        {
          Update: {
            TableName: deps.tableName,
            Key: { PK: pk, SK: tagSk(tag) },
            UpdateExpression: 'SET tag = :tag ADD imageCount :one',
            ExpressionAttributeValues: { ':tag': tag, ':one': 1 },
          },
        },
      ],
    }),
  );
}

/** Removes the tag from the image, with one less on its `TAG#` count. */
async function removeTag(
  deps: CollectionsDeps,
  pk: string,
  image: ImageItem,
  tag: string,
): Promise<void> {
  await transactWithCounters(
    deps,
    [
      {
        Update: {
          TableName: deps.tableName,
          Key: { PK: pk, SK: imageSk(image.imageId) },
          UpdateExpression: 'DELETE tags :tags',
          ConditionExpression: 'attribute_exists(PK) AND contains(tags, :tag)',
          ExpressionAttributeValues: { ':tags': new Set([tag]), ':tag': tag },
        },
      },
    ],
    [counterUpdate(deps.tableName, { PK: pk, SK: tagSk(tag) }, -1)],
  );
}
