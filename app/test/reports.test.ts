import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { userPk, versionSk } from '@pictora/core';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POST } from '../src/app/api/reports/route';
import { createReport, type ReportsDeps } from '../src/lib/reports';
import { SESSION_HEADERS, type Session } from '../src/lib/session';
import { DYNAMODB_ENDPOINT, localTable } from './dynamodb_local';

const IMAGE_ID = '01JAAAAAAAAAAAAAAAAAAAAAAA';
const NOW = new Date('2026-10-17T09:30:00.000Z');
const owner: Session = { sub: 'owner-sub', email: 'owner@example.com', groups: [] };
const other: Session = { sub: 'other-sub', email: 'other@example.com', groups: [] };

describe('POST /api/reports', () => {
  const url = 'https://pictora.example.dev/api/reports';

  it('answers 401 without a session', async () => {
    const response = await POST(new NextRequest(url, { method: 'POST', body: '{}' }));
    expect(response.status).toBe(401);
  });

  it('answers 400 when the body is not JSON', async () => {
    const response = await POST(
      new NextRequest(url, {
        method: 'POST',
        body: 'nope',
        headers: { [SESSION_HEADERS.sub]: 'u', [SESSION_HEADERS.email]: 'u@example.com' },
      }),
    );
    expect(response.status).toBe(400);
  });
});

describe.skipIf(!DYNAMODB_ENDPOINT)('createReport', () => {
  const table = localTable('pictora-reports');
  let ids = 0;
  const deps = (): ReportsDeps => ({
    client: table.client,
    tableName: table.tableName,
    now: () => NOW,
    newId: () => `01JREPORT${String(++ids).padStart(17, '0')}`,
  });

  beforeAll(async () => {
    await table.create();
    await table.client.send(
      new PutCommand({
        TableName: table.tableName,
        Item: {
          PK: userPk(owner.sub),
          SK: versionSk(IMAGE_ID, 1),
          imageId: IMAGE_ID,
          version: 1,
          s3Key: `users/${owner.sub}/${IMAGE_ID}/v1.png`,
          prompt: 'A lighthouse at dusk',
          modelId: 'gpt-image-2',
        },
      }),
    );
  });
  afterAll(() => table.drop());

  const modlog = async () =>
    (
      await table.client.send(
        new QueryCommand({
          TableName: table.tableName,
          KeyConditionExpression: 'PK = :pk',
          ExpressionAttributeValues: { ':pk': 'MODLOG#2026-10-17' },
        }),
      )
    ).Items ?? [];

  it('writes a report entry to the moderation log for the owner’s image', async () => {
    const result = await createReport(deps(), owner, {
      imageId: IMAGE_ID,
      version: 1,
      reason: 'violence',
    });
    expect(result.status).toBe(201);
    const reportId = result.body.reportId as string;
    expect(await modlog()).toContainEqual({
      PK: 'MODLOG#2026-10-17',
      SK: reportId,
      type: 'report',
      userId: owner.sub,
      reason: 'violence',
      imageId: IMAGE_ID,
      version: 1,
      s3Key: `users/${owner.sub}/${IMAGE_ID}/v1.png`,
      promptExcerpt: 'A lighthouse at dusk',
      modelId: 'gpt-image-2',
      createdAt: NOW.toISOString(),
      ttl: Math.floor(NOW.getTime() / 1000) + 90 * 86_400,
    });
  });

  it('answers 404 for an image the user does not own or that does not exist', async () => {
    const notFound = { status: 404, body: { code: 'not_found', error: 'Image not found.' } };
    const before = (await modlog()).length;
    expect(
      await createReport(deps(), other, { imageId: IMAGE_ID, version: 1, reason: 'hate' }),
    ).toEqual(notFound);
    expect(
      await createReport(deps(), owner, { imageId: IMAGE_ID, version: 2, reason: 'hate' }),
    ).toEqual(notFound);
    expect(await modlog()).toHaveLength(before);
  });

  it('rejects an invalid report', async () => {
    for (const input of [
      {},
      { imageId: IMAGE_ID, version: 1 },
      { imageId: IMAGE_ID, version: 1, reason: 'ugly' },
      { imageId: 'IMG1', version: 1, reason: 'hate' },
      { imageId: IMAGE_ID, version: 0, reason: 'hate' },
    ]) {
      expect(await createReport(deps(), owner, input)).toMatchObject({
        status: 400,
        body: { code: 'invalid_request' },
      });
    }
  });
});
