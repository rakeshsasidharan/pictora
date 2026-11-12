import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import {
  MAX_COLLECTIONS,
  MAX_TAGS_PER_IMAGE,
  PROFILE_SK,
  SEARCH_INDEX_VERSION,
  TESTERS_GROUP,
  collectionNameSk,
  collectionSk,
  imageKey,
  imageSk,
  searchWords,
  tagSk,
  thumbnailKey,
  userPk,
  versionSk,
} from '@pictora/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  bulkUpdate,
  createCollection,
  deleteCollection,
  listCollections,
  listTags,
  renameCollection,
  type BulkBody,
  type CollectionBody,
  type CollectionsBody,
  type CollectionsDeps,
  type TagsBody,
} from '../src/lib/collections';
import {
  deleteImage,
  getImageDetail,
  listImages,
  type GalleryPageBody,
  type ImageDetailBody,
} from '../src/lib/images';
import type { Session } from '../src/lib/session';
import { DYNAMODB_ENDPOINT, localTable } from './dynamodb_local';

/** A ULID-shaped image ID that sorts by `n`. */
const imageIdOf = (n: number) => `01J${String(n).padStart(23, '0')}`;
const MISSING_ID = '01JZZZZZZZZZZZZZZZZZZZZZZZ';

describe('collection and bulk input checks', () => {
  const deps = {
    client: { send: () => Promise.reject(new Error('DynamoDB should not be called')) },
    tableName: 'unused',
  } as unknown as CollectionsDeps;
  const session: Session = { sub: 'sub', email: 'a@example.com', groups: [] };

  it('refuses names and bulk requests that are not valid, before reading anything', async () => {
    for (const body of [{}, { name: '' }, { name: 'x'.repeat(61) }, { name: 'Logos', extra: 1 }]) {
      expect(await createCollection(deps, session, body)).toMatchObject({
        status: 400,
        body: { code: 'invalid_request' },
      });
    }
    expect(await bulkUpdate(deps, session, { action: 'delete', imageIds: [] })).toMatchObject({
      status: 400,
    });
    expect(
      await bulkUpdate(deps, session, { action: 'addTag', imageIds: [imageIdOf(1)], tag: '#x' }),
    ).toMatchObject({ status: 400 });
  });

  it('answers 404 for a collection ID that is not a ULID', async () => {
    expect(await renameCollection(deps, session, '../x', { name: 'A' })).toMatchObject({
      status: 404,
    });
    expect(await deleteCollection(deps, session, 'COL#x')).toMatchObject({ status: 404 });
  });

  it('refuses a search cursor that is not a position', async () => {
    const images = { ...deps, presign: async () => '', modelNames: async () => ({}) };
    expect(await listImages(images, session, imageIdOf(1), 24, { q: 'fox' })).toMatchObject({
      status: 400,
      body: { code: 'invalid_request' },
    });
  });
});

describe.skipIf(!DYNAMODB_ENDPOINT)('collections, tags and search against DynamoDB Local', () => {
  const table = localTable('pictora-collections');
  const { client, tableName } = table;
  const removePrefix = vi.fn<CollectionsDeps['removePrefix']>(async () => undefined);
  // Each call is a minute later, so the tests never fill a rate window.
  let minutes = 0;
  const deps: CollectionsDeps = {
    client,
    tableName,
    presign: async (key) => `https://signed.example/${key}`,
    removePrefix,
    modelNames: async () => ({ 'gemini-3-pro-image': 'Gemini 3 Pro Image', mock: 'Mock' }),
    now: () => new Date(Date.UTC(2026, 10, 1) + minutes++ * 60_000),
  };
  const put = (item: Record<string, unknown>) =>
    client.send(new PutCommand({ TableName: tableName, Item: item }));
  const get = async (pk: string, sk: string) =>
    (await client.send(new GetCommand({ TableName: tableName, Key: { PK: pk, SK: sk } }))).Item;

  let users = 0;
  async function newUser(status = 'active'): Promise<Session> {
    users += 1;
    const session: Session = {
      sub: `user-${users}-${Date.now()}`,
      email: 'a@example.com',
      groups: [TESTERS_GROUP],
    };
    await put({ PK: userPk(session.sub), SK: PROFILE_SK, status, email: session.email });
    return session;
  }

  interface ImageFields {
    prompt?: string;
    edits?: string[];
    style?: string;
    modelId?: string;
    source?: 'upload';
    /** False for an image made before search existed. */
    indexed?: boolean;
  }

  /** An image as the worker leaves it, with its versions. */
  async function putImage(sub: string, n: number, fields: ImageFields = {}) {
    const imageId = imageIdOf(n);
    const prompt = fields.prompt ?? `Image ${n}`;
    const edits = fields.edits ?? [];
    const words = searchWords(prompt, ...edits);
    await put({
      PK: userPk(sub),
      SK: imageSk(imageId),
      imageId,
      title: prompt,
      latestVersion: edits.length + 1,
      versionCount: edits.length + 1,
      style: fields.style ?? 'none',
      modelId: fields.modelId ?? 'mock',
      ...(fields.source ? { source: fields.source } : {}),
      createdAt: '2026-11-01T12:00:00.000Z',
      thumbKey: thumbnailKey(sub, imageId, 1),
      ...(fields.indexed === false
        ? {}
        : {
            searchVersion: SEARCH_INDEX_VERSION,
            ...(words.length ? { words: new Set(words) } : {}),
          }),
    });
    const versions = [{ prompt }, ...edits.map((editInstruction) => ({ editInstruction }))];
    for (const [index, version] of versions.entries()) {
      await put({
        PK: userPk(sub),
        SK: versionSk(imageId, index + 1),
        imageId,
        version: index + 1,
        s3Key: imageKey(sub, imageId, index + 1),
        thumbKey: thumbnailKey(sub, imageId, index + 1),
        width: 1024,
        height: 1024,
        ...version,
      });
    }
    return imageId;
  }

  async function newCollection(session: Session, name: string): Promise<CollectionBody> {
    const result = await createCollection(deps, session, { name });
    expect(result.status).toBe(201);
    return (result.body as { collection: CollectionBody }).collection;
  }

  async function bulk(session: Session, body: unknown) {
    const result = await bulkUpdate(deps, session, body);
    expect(result.status).toBe(200);
    return (result.body as unknown as BulkBody).results;
  }

  const collectionsOf = async (session: Session) =>
    ((await listCollections(deps, session)).body as unknown as CollectionsBody).collections;
  const tagsOf = async (session: Session) =>
    ((await listTags(deps, session)).body as unknown as TagsBody).tags;
  const page = async (
    session: Session,
    filter: Parameters<typeof listImages>[4],
    cursor?: string,
    limit?: number,
  ) => {
    const result = await listImages(deps, session, cursor, limit, filter);
    expect(result.status).toBe(200);
    return result.body as unknown as GalleryPageBody;
  };
  const ids = (body: GalleryPageBody) => body.images.map((image) => image.imageId);

  beforeAll(() => table.create());
  afterAll(() => table.drop());

  describe('collections', () => {
    it('creates them, lists them by name and keeps names unique whatever their case', async () => {
      const owner = await newUser();
      const logos = await newCollection(owner, '  Logos ');
      expect(logos).toMatchObject({ name: 'Logos', imageCount: 0 });
      await newCollection(owner, 'client x');
      expect(await createCollection(deps, owner, { name: 'LOGOS' })).toMatchObject({
        status: 409,
        body: { code: 'name_taken' },
      });
      expect((await collectionsOf(owner)).map((item) => item.name)).toEqual(['client x', 'Logos']);
      expect(await get(userPk(owner.sub), collectionNameSk('logos'))).toMatchObject({
        collectionId: logos.collectionId,
      });
    });

    it('renames, moving the name claim, and allows a change of case alone', async () => {
      const owner = await newUser();
      const logos = await newCollection(owner, 'Logos');
      await newCollection(owner, 'Icons');
      expect(
        await renameCollection(deps, owner, logos.collectionId, { name: 'icons' }),
      ).toMatchObject({ status: 409, body: { code: 'name_taken' } });

      expect(
        await renameCollection(deps, owner, logos.collectionId, { name: 'Brand marks' }),
      ).toMatchObject({ status: 200, body: { collection: { name: 'Brand marks' } } });
      expect(await get(userPk(owner.sub), collectionNameSk('logos'))).toBeUndefined();
      // The old name is free again.
      await newCollection(owner, 'Logos');

      expect(
        await renameCollection(deps, owner, logos.collectionId, { name: 'BRAND MARKS' }),
      ).toMatchObject({ status: 200 });
      expect(await get(userPk(owner.sub), collectionSk(logos.collectionId))).toMatchObject({
        name: 'BRAND MARKS',
      });
      expect(await get(userPk(owner.sub), collectionNameSk('brand marks'))).toMatchObject({
        collectionId: logos.collectionId,
      });
    });

    it(`stops at ${MAX_COLLECTIONS} collections`, async () => {
      const owner = await newUser();
      for (let n = 1; n <= MAX_COLLECTIONS; n++) {
        await put({
          PK: userPk(owner.sub),
          SK: collectionSk(imageIdOf(n)),
          collectionId: imageIdOf(n),
          name: `C${n}`,
        });
      }
      expect(await createCollection(deps, owner, { name: 'One more' })).toMatchObject({
        status: 409,
        body: { code: 'limit_reached' },
      });
    });

    it('refuses a new collection once the account is being deleted', async () => {
      const leaving = await newUser('deleting');
      expect(await createCollection(deps, leaving, { name: 'Logos' })).toMatchObject({
        status: 403,
        body: { code: 'account_deleting' },
      });
      expect(await collectionsOf(leaving)).toEqual([]);
    });

    it("answers 404 for another user's collection, everywhere, and leaves it alone", async () => {
      const owner = await newUser();
      const other = await newUser();
      const logos = await newCollection(owner, 'Logos');
      const imageId = await putImage(other.sub, 1);

      expect(await collectionsOf(other)).toEqual([]);
      expect(
        await renameCollection(deps, other, logos.collectionId, { name: 'Mine' }),
      ).toMatchObject({ status: 404 });
      expect(await deleteCollection(deps, other, logos.collectionId)).toMatchObject({
        status: 404,
      });
      expect(
        await listImages(deps, other, undefined, undefined, { collection: logos.collectionId }),
      ).toMatchObject({ status: 404 });
      expect(
        await bulkUpdate(deps, other, {
          action: 'move',
          imageIds: [imageId],
          collectionId: logos.collectionId,
        }),
      ).toMatchObject({ status: 404 });
      expect(await get(userPk(other.sub), imageSk(imageId))).not.toHaveProperty('collectionId');
      expect(await collectionsOf(owner)).toEqual([expect.objectContaining({ name: 'Logos' })]);
    });

    it('moves images in, between and out of collections, keeping the counts', async () => {
      const owner = await newUser();
      const logos = await newCollection(owner, 'Logos');
      const icons = await newCollection(owner, 'Icons');
      const images = [await putImage(owner.sub, 1), await putImage(owner.sub, 2)];

      expect(
        await bulk(owner, { action: 'move', imageIds: images, collectionId: logos.collectionId }),
      ).toEqual(images.map((imageId) => ({ imageId, ok: true })));
      // Moving again to the same collection changes nothing.
      await bulk(owner, { action: 'move', imageIds: images, collectionId: logos.collectionId });
      expect(await collectionsOf(owner)).toEqual([
        expect.objectContaining({ name: 'Icons', imageCount: 0 }),
        expect.objectContaining({ name: 'Logos', imageCount: 2 }),
      ]);

      await bulk(owner, {
        action: 'move',
        imageIds: [images[0]],
        collectionId: icons.collectionId,
      });
      await bulk(owner, { action: 'move', imageIds: [images[1]], collectionId: null });
      expect(await collectionsOf(owner)).toEqual([
        expect.objectContaining({ name: 'Icons', imageCount: 1 }),
        expect.objectContaining({ name: 'Logos', imageCount: 0 }),
      ]);
      const unfiled = await get(userPk(owner.sub), imageSk(images[1]!));
      expect(unfiled).not.toHaveProperty('collectionId');
      expect(unfiled).not.toHaveProperty('GSI1PK');

      const detail = (await getImageDetail(deps, owner, images[0]!))
        .body as unknown as ImageDetailBody;
      expect(detail.image.collection).toEqual({ collectionId: icons.collectionId, name: 'Icons' });
    });

    it("shows a collection's images newest first, a page at a time", async () => {
      const owner = await newUser();
      const logos = await newCollection(owner, 'Logos');
      const images: string[] = [];
      for (let n = 1; n <= 30; n++) images.push(await putImage(owner.sub, n));
      // Images 1 to 26 go in; 27 to 30 stay out.
      await bulk(owner, {
        action: 'move',
        imageIds: images.slice(0, 26),
        collectionId: logos.collectionId,
      });

      const first = await page(owner, { collection: logos.collectionId });
      expect(ids(first)).toEqual(Array.from({ length: 24 }, (_, index) => imageIdOf(26 - index)));
      expect(first.images[0]).toMatchObject({ collectionId: logos.collectionId, tags: [] });
      expect(first.nextCursor).toBe(imageIdOf(3));
      expect(first).not.toHaveProperty('jobs');
      const second = await page(owner, { collection: logos.collectionId }, first.nextCursor);
      expect(ids(second)).toEqual([imageIdOf(2), imageIdOf(1)]);
      expect(second.nextCursor).toBeUndefined();
    });

    it('deletes a collection, keeping its images in the gallery', async () => {
      const owner = await newUser();
      const logos = await newCollection(owner, 'Logos');
      const images = [await putImage(owner.sub, 1), await putImage(owner.sub, 2)];
      await bulk(owner, { action: 'move', imageIds: images, collectionId: logos.collectionId });

      expect(await deleteCollection(deps, owner, logos.collectionId)).toEqual({
        status: 200,
        body: { collectionId: logos.collectionId, deleted: true, imagesUnfiled: 2 },
      });
      expect(await get(userPk(owner.sub), collectionSk(logos.collectionId))).toBeUndefined();
      expect(await get(userPk(owner.sub), collectionNameSk('Logos'))).toBeUndefined();
      for (const imageId of images) {
        const image = await get(userPk(owner.sub), imageSk(imageId));
        expect(image).toBeDefined();
        expect(image).not.toHaveProperty('collectionId');
        expect(image).not.toHaveProperty('GSI1PK');
      }
      expect(ids(await page(owner, {}))).toEqual([...images].reverse());
      // The name can be used again.
      await newCollection(owner, 'Logos');
      expect(await deleteCollection(deps, owner, logos.collectionId)).toMatchObject({
        status: 404,
      });
    });
  });

  describe('tags', () => {
    it('adds and removes tags, keeping a count of each and deleting it when unused', async () => {
      const owner = await newUser();
      const images = [await putImage(owner.sub, 1), await putImage(owner.sub, 2)];
      expect(await bulk(owner, { action: 'addTag', imageIds: images, tag: ' Sunset ' })).toEqual(
        images.map((imageId) => ({ imageId, ok: true })),
      );
      await bulk(owner, { action: 'addTag', imageIds: [images[0]], tag: 'beach' });
      // Adding a tag the image has changes nothing.
      await bulk(owner, { action: 'addTag', imageIds: [images[0]], tag: 'SUNSET' });
      expect(await tagsOf(owner)).toEqual([
        { tag: 'sunset', imageCount: 2 },
        { tag: 'beach', imageCount: 1 },
      ]);
      expect((await get(userPk(owner.sub), imageSk(images[0]!)))?.tags).toEqual(
        new Set(['sunset', 'beach']),
      );

      await bulk(owner, { action: 'removeTag', imageIds: images, tag: 'sunset' });
      expect(await tagsOf(owner)).toEqual([{ tag: 'beach', imageCount: 1 }]);
      expect(await get(userPk(owner.sub), tagSk('sunset'))).toBeUndefined();
      expect(await get(userPk(owner.sub), imageSk(images[1]!))).not.toHaveProperty('tags');

      const detail = (await getImageDetail(deps, owner, images[0]!))
        .body as unknown as ImageDetailBody;
      expect(detail.image.tags).toEqual(['beach']);
    });

    it(`stops at ${MAX_TAGS_PER_IMAGE} tags on an image`, async () => {
      const owner = await newUser();
      const imageId = await putImage(owner.sub, 1);
      await put({
        PK: userPk(owner.sub),
        SK: imageSk(imageId),
        ...(await get(userPk(owner.sub), imageSk(imageId))),
        tags: new Set(Array.from({ length: MAX_TAGS_PER_IMAGE }, (_, n) => `tag ${n}`)),
      });
      expect(await bulk(owner, { action: 'addTag', imageIds: [imageId], tag: 'one more' })).toEqual(
        [
          {
            imageId,
            ok: false,
            code: 'too_many_tags',
            error: `An image can have at most ${MAX_TAGS_PER_IMAGE} tags.`,
          },
        ],
      );
      expect(await get(userPk(owner.sub), tagSk('one more'))).toBeUndefined();
    });

    it("reports another user's images as not found and changes nothing of theirs", async () => {
      const owner = await newUser();
      const other = await newUser();
      const imageId = await putImage(owner.sub, 1);
      for (const body of [
        { action: 'addTag', imageIds: [imageId], tag: 'mine' },
        { action: 'removeTag', imageIds: [imageId], tag: 'mine' },
        { action: 'move', imageIds: [imageId], collectionId: null },
        { action: 'delete', imageIds: [imageId] },
      ]) {
        expect(await bulk(other, body)).toEqual([
          { imageId, ok: false, code: 'not_found', error: 'Image not found.' },
        ]);
      }
      expect(await get(userPk(other.sub), tagSk('mine'))).toBeUndefined();
      expect(await get(userPk(owner.sub), imageSk(imageId))).toBeDefined();
      expect(removePrefix).not.toHaveBeenCalledWith(`users/${owner.sub}/${imageId}/`);
    });

    it('refuses a new tag once the account is being deleted', async () => {
      const leaving = await newUser('deleting');
      const imageId = await putImage(leaving.sub, 1);
      expect(await bulk(leaving, { action: 'addTag', imageIds: [imageId], tag: 'late' })).toEqual([
        expect.objectContaining({ imageId, ok: false, code: 'failed' }),
      ]);
      expect(await get(userPk(leaving.sub), tagSk('late'))).toBeUndefined();
    });
  });

  describe('deleting images', () => {
    it("takes a deleted image off its collection's and tags' counts", async () => {
      const owner = await newUser();
      const logos = await newCollection(owner, 'Logos');
      const images = [await putImage(owner.sub, 1), await putImage(owner.sub, 2)];
      await bulk(owner, { action: 'move', imageIds: images, collectionId: logos.collectionId });
      await bulk(owner, { action: 'addTag', imageIds: images, tag: 'kept' });
      await bulk(owner, { action: 'addTag', imageIds: [images[0]], tag: 'only' });

      expect(await deleteImage(deps, owner, images[0]!)).toMatchObject({ status: 200 });
      expect(await collectionsOf(owner)).toEqual([
        expect.objectContaining({ name: 'Logos', imageCount: 1 }),
      ]);
      expect(await tagsOf(owner)).toEqual([{ tag: 'kept', imageCount: 1 }]);
      expect(await get(userPk(owner.sub), tagSk('only'))).toBeUndefined();
      expect(await get(userPk(owner.sub), versionSk(images[0]!, 1))).toBeUndefined();
    });

    it('still deletes an image whose collection was deleted in the meantime', async () => {
      const owner = await newUser();
      const imageId = await putImage(owner.sub, 1);
      // The image still names a collection that is gone.
      await put({
        ...(await get(userPk(owner.sub), imageSk(imageId))),
        collectionId: MISSING_ID,
      });
      expect(await deleteImage(deps, owner, imageId)).toMatchObject({ status: 200 });
      expect(await get(userPk(owner.sub), imageSk(imageId))).toBeUndefined();
      expect(await get(userPk(owner.sub), collectionSk(MISSING_ID))).toBeUndefined();
    });

    it('deletes many at once, reporting each', async () => {
      const owner = await newUser();
      const images = [await putImage(owner.sub, 1), await putImage(owner.sub, 2)];
      expect(await bulk(owner, { action: 'delete', imageIds: [...images, MISSING_ID] })).toEqual([
        { imageId: images[0], ok: true },
        { imageId: images[1], ok: true },
        { imageId: MISSING_ID, ok: false, code: 'not_found', error: 'Image not found.' },
      ]);
      expect(removePrefix).toHaveBeenCalledWith(`users/${owner.sub}/${images[0]}/`);
      expect(ids(await page(owner, {}))).toEqual([]);
    });
  });

  describe('filtering and search', () => {
    it('filters by a tag of the user or an automatic tag, with a count and pages by position', async () => {
      const owner = await newUser();
      await putImage(owner.sub, 1, { style: 'watercolour', modelId: 'gemini-3-pro-image' });
      await putImage(owner.sub, 2, { style: 'watercolour' });
      await putImage(owner.sub, 3, { style: 'anime' });
      await putImage(owner.sub, 4, { source: 'upload' });
      await bulk(owner, { action: 'addTag', imageIds: [imageIdOf(3)], tag: 'Watercolour' });

      const first = await page(owner, { tag: 'WATERCOLOUR' }, undefined, 2);
      expect(first.total).toBe(3);
      expect(ids(first)).toEqual([imageIdOf(3), imageIdOf(2)]);
      expect(first.nextCursor).toBe('2');
      const second = await page(owner, { tag: 'watercolour' }, first.nextCursor, 2);
      expect(ids(second)).toEqual([imageIdOf(1)]);
      expect(second.nextCursor).toBeUndefined();

      expect(ids(await page(owner, { tag: 'Gemini 3 Pro Image' }))).toEqual([imageIdOf(1)]);
      expect(ids(await page(owner, { tag: 'upload' }))).toEqual([imageIdOf(4)]);
      expect((await page(owner, { tag: 'nothing' })).total).toBe(0);

      const detail = (await getImageDetail(deps, owner, imageIdOf(1)))
        .body as unknown as ImageDetailBody;
      expect(detail.image.autoTags).toEqual(['Watercolour', 'Gemini 3 Pro Image']);
    });

    it('ranks search results on fixture data, best match first, then newest', async () => {
      const owner = await newUser();
      await putImage(owner.sub, 1, { prompt: 'A red fox asleep in the snow' });
      await putImage(owner.sub, 2, { prompt: 'Foxglove flowers in a cottage garden' });
      await putImage(owner.sub, 3, { prompt: 'A sleepy animal in the forest' });
      await putImage(owner.sub, 4, { prompt: 'A neon city at night', edits: ['Add a fox'] });
      await putImage(owner.sub, 5, { prompt: 'Snowy mountains at dawn' });
      await bulk(owner, { action: 'addTag', imageIds: [imageIdOf(3)], tag: 'fox' });

      const fox = await page(owner, { q: 'fox' });
      // A whole tag, then whole prompt or edit words (newest first), then a prefix.
      expect(ids(fox)).toEqual([imageIdOf(3), imageIdOf(4), imageIdOf(1), imageIdOf(2)]);
      expect(fox.total).toBe(4);
      expect(ids(await page(owner, { q: 'red FOX' }))).toEqual([imageIdOf(1)]);
      expect(ids(await page(owner, { q: 'snow' }))).toEqual([imageIdOf(1), imageIdOf(5)]);
      expect(ids(await page(owner, { q: 'the fox and the snow' }))).toEqual([imageIdOf(1)]);
      expect((await page(owner, { q: 'giraffe' })).total).toBe(0);
    });

    it('searches within a collection and a tag at once', async () => {
      const owner = await newUser();
      const logos = await newCollection(owner, 'Logos');
      await putImage(owner.sub, 1, { prompt: 'Fox logo, flat' });
      await putImage(owner.sub, 2, { prompt: 'Fox logo, round' });
      await putImage(owner.sub, 3, { prompt: 'Fox logo, square' });
      await bulk(owner, {
        action: 'move',
        imageIds: [imageIdOf(1), imageIdOf(2)],
        collectionId: logos.collectionId,
      });
      await bulk(owner, { action: 'addTag', imageIds: [imageIdOf(2), imageIdOf(3)], tag: 'final' });

      expect(ids(await page(owner, { q: 'logo', collection: logos.collectionId }))).toEqual([
        imageIdOf(2),
        imageIdOf(1),
      ]);
      expect(
        ids(await page(owner, { q: 'logo', tag: 'final', collection: logos.collectionId })),
      ).toEqual([imageIdOf(2)]);
    });

    it('indexes images made before search from their versions, the first time a search reads them', async () => {
      const owner = await newUser();
      const imageId = await putImage(owner.sub, 1, {
        prompt: 'A lighthouse at dusk',
        edits: ['Add a rainbow'],
        indexed: false,
      });
      expect(await get(userPk(owner.sub), imageSk(imageId))).not.toHaveProperty('words');

      expect(ids(await page(owner, { q: 'rainbow' }))).toEqual([imageId]);
      expect(await get(userPk(owner.sub), imageSk(imageId))).toMatchObject({
        words: new Set(['lighthouse', 'dusk', 'add', 'rainbow']),
        searchVersion: SEARCH_INDEX_VERSION,
      });
      // A tag filter alone doesn't need the words.
      const other = await putImage(owner.sub, 2, { indexed: false });
      await page(owner, { tag: 'anything' });
      expect(await get(userPk(owner.sub), imageSk(other))).not.toHaveProperty('searchVersion');
    });

    it('lists the jobs only on the whole gallery', async () => {
      const owner = await newUser();
      await putImage(owner.sub, 1);
      expect(await page(owner, {})).toHaveProperty('jobs');
      expect(await page(owner, { q: 'image' })).not.toHaveProperty('jobs');
    });
  });
});
