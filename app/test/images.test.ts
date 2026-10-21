import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { imageKey, imageSk, thumbnailKey, userPk, versionSk } from '@pictora/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getImageDetail, type ImageDetailBody, type ImagesDeps } from '../src/lib/images';
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
