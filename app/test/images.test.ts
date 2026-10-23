import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { imageKey, imageSk, jobPk, thumbnailKey, userPk, versionSk } from '@pictora/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  GALLERY_PAGE_SIZE,
  deleteImage,
  getImageDetail,
  listImages,
  rerunSettings,
  versionDownloadUrl,
  type GalleryPageBody,
  type ImageDeleteDeps,
  type ImageDetailBody,
  type ImagesDeps,
} from '../src/lib/images';
import type { Session } from '../src/lib/session';
import { DYNAMODB_ENDPOINT, localTable } from './dynamodb_local';

const IMAGE_ID = '01JAAAAAAAAAAAAAAAAAAAAAAA';

describe('getImageDetail', () => {
  it('answers 404 for an ID that is not a ULID without reading the table', async () => {
    const deps: ImagesDeps = {
      client: {
        send: () => Promise.reject(new Error('DynamoDB should not be called')),
      } as unknown as ImagesDeps['client'],
      tableName: 'unused',
      presign: async (key) => key,
    };
    const session: Session = { sub: 'sub', email: 'a@example.com', groups: [] };
    expect(await getImageDetail(deps, session, '../etc')).toMatchObject({ status: 404 });
  });
});

describe.skipIf(!DYNAMODB_ENDPOINT)('getImageDetail against DynamoDB Local', () => {
  const table = localTable('pictora-images');
  const { client, tableName } = table;
  const deps: ImagesDeps = {
    client,
    tableName,
    presign: async (key, downloadName) =>
      `https://signed.example/${key}${downloadName ? `?download=${downloadName}` : ''}`,
  };
  const owner: Session = { sub: `owner-${Date.now()}`, email: 'a@example.com', groups: [] };
  const put = (item: Record<string, unknown>) =>
    client.send(new PutCommand({ TableName: tableName, Item: item }));

  beforeAll(async () => {
    await table.create();
    await put({
      PK: userPk(owner.sub),
      SK: imageSk(IMAGE_ID),
      imageId: IMAGE_ID,
      title: 'A lighthouse at dusk',
      latestVersion: 10,
      versionCount: 3,
      createdAt: '2026-10-15T12:00:00.000Z',
    });
    for (const version of [1, 2, 10]) {
      await put({
        PK: userPk(owner.sub),
        SK: versionSk(IMAGE_ID, version),
        imageId: IMAGE_ID,
        version,
        s3Key: imageKey(owner.sub, IMAGE_ID, version),
        thumbKey: thumbnailKey(owner.sub, IMAGE_ID, version),
        width: 1024,
        height: 1024,
        ...(version === 1
          ? { prompt: 'A lighthouse at dusk', modelId: 'mock' }
          : { parentVersion: 1, editInstruction: `Edit ${version}` }),
        createdAt: '2026-10-15T12:00:00.000Z',
      });
    }
    // Another image whose ID starts the same way must not be listed.
    await put({
      PK: userPk(owner.sub),
      SK: versionSk(`${IMAGE_ID}X`, 1),
      version: 1,
      s3Key: imageKey(owner.sub, `${IMAGE_ID}X`, 1),
      thumbKey: thumbnailKey(owner.sub, `${IMAGE_ID}X`, 1),
    });
  });
  afterAll(() => table.drop());

  it('returns the image and its versions in number order, with presigned URLs', async () => {
    const result = await getImageDetail(deps, owner, IMAGE_ID);
    expect(result.status).toBe(200);
    const body = result.body as unknown as ImageDetailBody;
    expect(body.image).toEqual({
      imageId: IMAGE_ID,
      title: 'A lighthouse at dusk',
      latestVersion: 10,
      versionCount: 3,
      createdAt: '2026-10-15T12:00:00.000Z',
    });
    expect(body.versions.map((version) => version.version)).toEqual([1, 2, 10]);
    expect(body.versions[0]).toMatchObject({
      prompt: 'A lighthouse at dusk',
      modelId: 'mock',
      url: `https://signed.example/${imageKey(owner.sub, IMAGE_ID, 1)}`,
      downloadUrl: `https://signed.example/${imageKey(owner.sub, IMAGE_ID, 1)}?download=pictora-${IMAGE_ID}-v1.png`,
      thumbUrl: `https://signed.example/${thumbnailKey(owner.sub, IMAGE_ID, 1)}`,
    });
    expect(body.versions[0]).not.toHaveProperty('parentVersion');
    expect(body.versions[2]).toMatchObject({ parentVersion: 1, editInstruction: 'Edit 10' });
  });

  it("answers 404 for another user's image", async () => {
    const other: Session = { sub: `other-${Date.now()}`, email: 'b@example.com', groups: [] };
    expect(await getImageDetail(deps, other, IMAGE_ID)).toMatchObject({
      status: 404,
      body: { code: 'not_found' },
    });
  });
});

describe('image API input checks', () => {
  const deps: ImageDeleteDeps = {
    client: {
      send: () => Promise.reject(new Error('DynamoDB should not be called')),
    } as unknown as ImagesDeps['client'],
    tableName: 'unused',
    presign: async (key) => key,
    removePrefix: () => Promise.reject(new Error('S3 should not be called')),
  };
  const session: Session = { sub: 'sub', email: 'a@example.com', groups: [] };

  it('refuses a cursor that is not an image ID', async () => {
    expect(await listImages(deps, session, 'IMG#x')).toMatchObject({
      status: 400,
      body: { code: 'invalid_request' },
    });
  });

  it('finds nothing for IDs or versions that are not valid', async () => {
    expect(await versionDownloadUrl(deps, session, '../x', '1')).toBeUndefined();
    expect(await versionDownloadUrl(deps, session, IMAGE_ID, '0')).toBeUndefined();
    expect(await versionDownloadUrl(deps, session, IMAGE_ID, '1.5')).toBeUndefined();
    expect(await deleteImage(deps, session, 'nope')).toMatchObject({ status: 404 });
    expect(await rerunSettings(deps, session, 'nope')).toBeUndefined();
  });
});

describe.skipIf(!DYNAMODB_ENDPOINT)('gallery API against DynamoDB Local', () => {
  const table = localTable('pictora-gallery');
  const { client, tableName } = table;
  const removed: string[] = [];
  const deps: ImageDeleteDeps = {
    client,
    tableName,
    presign: async (key, downloadName) =>
      `https://signed.example/${key}${downloadName ? `?download=${downloadName}` : ''}`,
    removePrefix: async (prefix) => {
      removed.push(prefix);
    },
  };
  const put = (item: Record<string, unknown>) =>
    client.send(new PutCommand({ TableName: tableName, Item: item }));
  const get = async (pk: string, sk: string) =>
    (await client.send(new GetCommand({ TableName: tableName, Key: { PK: pk, SK: sk } }))).Item;
  let users = 0;
  const newSession = (): Session => {
    users += 1;
    return { sub: `user-${users}-${Date.now()}`, email: 'a@example.com', groups: [] };
  };

  /** A ULID-shaped image ID that sorts by `n`. */
  const imageIdOf = (n: number) => `01J${String(n).padStart(23, '0')}`;

  async function putImage(sub: string, imageId: string, versions = [1]) {
    await put({
      PK: userPk(sub),
      SK: imageSk(imageId),
      imageId,
      title: `Image ${imageId.slice(-3)}`,
      latestVersion: Math.max(...versions),
      versionCount: versions.length,
      style: 'watercolour',
      modelId: 'mock',
      createdAt: '2026-10-15T12:00:00.000Z',
      thumbKey: thumbnailKey(sub, imageId, Math.max(...versions)),
    });
    for (const version of versions) {
      await put({
        PK: userPk(sub),
        SK: versionSk(imageId, version),
        imageId,
        version,
        s3Key: imageKey(sub, imageId, version),
        thumbKey: thumbnailKey(sub, imageId, version),
        width: 1024,
        height: 768,
        ...(version === 1
          ? {
              prompt: 'A lighthouse at dusk',
              enhancedPrompt: 'A lighthouse at dusk, warm light',
              avoid: 'text',
              style: 'watercolour',
              modelId: 'mock',
              quality: 'draft',
              aspect: '3:2',
              seed: 42,
              transparentBackground: true,
            }
          : { parentVersion: version - 1, editInstruction: `Edit ${version}`, modelId: 'mock' }),
        createdAt: '2026-10-15T12:00:00.000Z',
      });
    }
  }

  async function putJob(
    sub: string,
    jobId: string,
    status: string,
    request: Record<string, unknown>,
    createdAt: string,
  ) {
    const active = status === 'queued' || status === 'running';
    await put({
      PK: jobPk(jobId),
      SK: 'META',
      jobId,
      userId: sub,
      type: request.type,
      status,
      request,
      modelId: 'mock',
      createdAt,
      ...(active ? { GSI1PK: `JOBS#${status}`, GSI1SK: createdAt } : {}),
    });
  }

  beforeAll(() => table.create());
  afterAll(() => table.drop());

  it('pages through the images newest first, 24 at a time, with presigned thumbnails', async () => {
    const owner = newSession();
    for (let n = 1; n <= 30; n++) await putImage(owner.sub, imageIdOf(n));
    const other = newSession();
    await putImage(other.sub, imageIdOf(99));

    const first = (await listImages(deps, owner)).body as unknown as GalleryPageBody;
    expect(first.images).toHaveLength(GALLERY_PAGE_SIZE);
    expect(first.images[0]).toEqual({
      imageId: imageIdOf(30),
      title: 'Image 030',
      latestVersion: 1,
      versionCount: 1,
      createdAt: '2026-10-15T12:00:00.000Z',
      thumbUrl: `https://signed.example/${thumbnailKey(owner.sub, imageIdOf(30), 1)}`,
    });
    expect(first.images.at(-1)?.imageId).toBe(imageIdOf(7));
    expect(first.nextCursor).toBe(imageIdOf(7));
    expect(first.jobs).toEqual([]);

    const second = (await listImages(deps, owner, first.nextCursor))
      .body as unknown as GalleryPageBody;
    expect(second.images.map((image) => image.imageId)).toEqual([6, 5, 4, 3, 2, 1].map(imageIdOf));
    expect(second.nextCursor).toBeUndefined();
    // Running jobs come with the first page only.
    expect(second).not.toHaveProperty('jobs');
  });

  it('answers pages of the asked-for size, newest first', async () => {
    const owner = newSession();
    for (let n = 1; n <= 12; n++) await putImage(owner.sub, imageIdOf(n));

    const first = (await listImages(deps, owner, undefined, 10)).body as unknown as GalleryPageBody;
    expect(first.images.map((image) => image.imageId)).toEqual(
      [12, 11, 10, 9, 8, 7, 6, 5, 4, 3].map(imageIdOf),
    );
    expect(first.nextCursor).toBe(imageIdOf(3));

    const second = (await listImages(deps, owner, first.nextCursor, 10))
      .body as unknown as GalleryPageBody;
    expect(second.images.map((image) => image.imageId)).toEqual([2, 1].map(imageIdOf));
  });

  it('answers an empty first page for a new user', async () => {
    expect((await listImages(deps, newSession())).body).toEqual({ images: [], jobs: [] });
  });

  it("lists the caller's queued and running jobs, newest first, and no one else's", async () => {
    const owner = newSession();
    const other = newSession();
    await putImage(owner.sub, imageIdOf(1));
    await putJob(
      owner.sub,
      '01JQ0000000000000000000001',
      'queued',
      { type: 'generate', prompt: 'Two cats', count: 2 },
      '2026-10-15T12:00:02.000Z',
    );
    await putJob(
      owner.sub,
      '01JQ0000000000000000000002',
      'running',
      { type: 'edit', imageId: imageIdOf(1), instruction: 'Make it night', parentVersion: 1 },
      '2026-10-15T12:00:01.000Z',
    );
    await putJob(
      owner.sub,
      '01JQ0000000000000000000003',
      'succeeded',
      { type: 'generate', prompt: 'Done already', count: 1 },
      '2026-10-15T12:00:03.000Z',
    );
    await putJob(
      other.sub,
      '01JQ0000000000000000000004',
      'queued',
      { type: 'generate', prompt: 'Not yours', count: 1 },
      '2026-10-15T12:00:04.000Z',
    );

    const page = (await listImages(deps, owner)).body as unknown as GalleryPageBody;
    expect(page.jobs).toEqual([
      {
        jobId: '01JQ0000000000000000000001',
        type: 'generate',
        status: 'queued',
        createdAt: '2026-10-15T12:00:02.000Z',
        text: 'Two cats',
        count: 2,
      },
      {
        jobId: '01JQ0000000000000000000002',
        type: 'edit',
        status: 'running',
        createdAt: '2026-10-15T12:00:01.000Z',
        text: 'Make it night',
        count: 1,
        imageId: imageIdOf(1),
      },
    ]);
  });

  it('returns the seed, style and settings of each version in the detail', async () => {
    const owner = newSession();
    await putImage(owner.sub, imageIdOf(5), [1, 2]);
    const body = (await getImageDetail(deps, owner, imageIdOf(5)))
      .body as unknown as ImageDetailBody;
    expect(body.image).toMatchObject({ style: 'watercolour', modelId: 'mock' });
    expect(body.versions[0]).toMatchObject({
      prompt: 'A lighthouse at dusk',
      enhancedPrompt: 'A lighthouse at dusk, warm light',
      avoid: 'text',
      style: 'watercolour',
      quality: 'draft',
      aspect: '3:2',
      seed: 42,
      transparentBackground: true,
    });
    expect(body.versions[1]).toMatchObject({ editInstruction: 'Edit 2', parentVersion: 1 });
  });

  it("presigns a version's original PNG as a download for its owner only", async () => {
    const owner = newSession();
    await putImage(owner.sub, imageIdOf(6), [1, 2]);
    expect(await versionDownloadUrl(deps, owner, imageIdOf(6), '2')).toBe(
      `https://signed.example/${imageKey(owner.sub, imageIdOf(6), 2)}?download=pictora-${imageIdOf(6)}-v2.png`,
    );
    expect(await versionDownloadUrl(deps, owner, imageIdOf(6), '3')).toBeUndefined();
    expect(await versionDownloadUrl(deps, newSession(), imageIdOf(6), '1')).toBeUndefined();
  });

  it('reads the settings to rerun a generated image, for its owner only', async () => {
    const owner = newSession();
    await putImage(owner.sub, imageIdOf(7), [1, 2]);
    expect(await rerunSettings(deps, owner, imageIdOf(7))).toEqual({
      prompt: 'A lighthouse at dusk',
      enhancedPrompt: 'A lighthouse at dusk, warm light',
      avoid: 'text',
      style: 'watercolour',
      modelId: 'mock',
      quality: 'draft',
      aspect: '3:2',
      seed: 42,
      transparentBackground: true,
    });
    expect(await rerunSettings(deps, newSession(), imageIdOf(7))).toBeUndefined();

    // An uploaded image has no prompt to rerun.
    const uploaded = imageIdOf(8);
    await put({
      PK: userPk(owner.sub),
      SK: versionSk(uploaded, 1),
      version: 1,
      source: 'upload',
      s3Key: imageKey(owner.sub, uploaded, 1),
      thumbKey: thumbnailKey(owner.sub, uploaded, 1),
    });
    expect(await rerunSettings(deps, owner, uploaded)).toBeUndefined();
  });

  it('deletes every version item and every object of the image', async () => {
    const owner = newSession();
    const imageId = imageIdOf(9);
    // Version 3 is a gap: an edit claimed it and failed.
    await putImage(owner.sub, imageId, [1, 2, 4]);
    await putImage(owner.sub, imageIdOf(10));
    removed.length = 0;

    expect(await deleteImage(deps, owner, imageId)).toEqual({
      status: 200,
      body: { imageId, deleted: true },
    });
    const prefix = `users/${owner.sub}/${imageId}/`;
    // Swept before the items go, and again after, for an edit that stored its result in between.
    expect(removed).toEqual([prefix, prefix]);
    expect(await get(userPk(owner.sub), imageSk(imageId))).toBeUndefined();
    for (const version of [1, 2, 4]) {
      expect(await get(userPk(owner.sub), versionSk(imageId, version))).toBeUndefined();
    }
    // The other image stays.
    expect(await get(userPk(owner.sub), imageSk(imageIdOf(10)))).toBeDefined();
    expect(await getImageDetail(deps, owner, imageId)).toMatchObject({ status: 404 });
  });

  it("answers 404 for another user's image and deletes nothing", async () => {
    const owner = newSession();
    await putImage(owner.sub, imageIdOf(11));
    removed.length = 0;
    expect(await deleteImage(deps, newSession(), imageIdOf(11))).toMatchObject({
      status: 404,
      body: { code: 'not_found' },
    });
    expect(removed).toEqual([]);
    expect(await get(userPk(owner.sub), imageSk(imageIdOf(11)))).toBeDefined();
  });

  it('keeps the items when deleting the objects fails, so the image can be deleted again', async () => {
    const owner = newSession();
    await putImage(owner.sub, imageIdOf(12));
    const failing: ImageDeleteDeps = {
      ...deps,
      removePrefix: () => Promise.reject(new Error('S3 is down')),
    };
    expect(await deleteImage(failing, owner, imageIdOf(12))).toMatchObject({
      status: 503,
      body: { code: 'deletion_failed' },
    });
    expect(await get(userPk(owner.sub), imageSk(imageIdOf(12)))).toBeDefined();
    expect(await get(userPk(owner.sub), versionSk(imageIdOf(12), 1))).toBeDefined();
  });
});
