import { S3Client } from '@aws-sdk/client-s3';
import { GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  MAX_UPLOAD_BYTES,
  PROFILE_SK,
  TOS_VERSION,
  imageKey,
  imageSk,
  thumbnailKey,
  uploadKey,
  userPk,
  versionSk,
  type ModerationResult,
} from '@pictora/core';
import { prepareUpload } from '@pictora/providers/image';
import type { Moderate } from '@pictora/providers/text';
import { NextRequest } from 'next/server';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as completeRoute } from '../src/app/api/uploads/[id]/complete/route';
import { POST as uploadsRoute } from '../src/app/api/uploads/route';
import { presignUpload, type UploadStorage } from '../src/lib/images_bucket';
import { SESSION_HEADERS, type Session } from '../src/lib/session';
import { UPLOAD_TITLE, completeUpload, createUpload, type UploadsDeps } from '../src/lib/uploads';
import { DYNAMODB_ENDPOINT, localTable } from './dynamodb_local';

const NOW = new Date('2026-10-19T10:00:00.000Z');
const ONBOARDED = {
  tosAcceptedAt: '2026-10-14T09:00:00.000Z',
  tosVersion: TOS_VERSION,
  ageConfirmed: true,
};
const clean: ModerationResult = { flagged: false, categories: {} };
const sexual: ModerationResult = { flagged: true, categories: { sexual: true } };

async function jpeg(width = 640, height = 480): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({ create: { width, height, channels: 3, background: { r: 30, g: 120, b: 200 } } })
      .jpeg()
      .toBuffer(),
  );
}

/** The images bucket in memory: objects by key, and every presigned POST asked for. */
function memoryStorage() {
  const objects = new Map<string, { body: Uint8Array; contentType?: string }>();
  const storage: UploadStorage = {
    presignUpload: vi.fn(async (key: string, contentType: string) => ({
      url: 'https://bucket.s3.us-west-2.amazonaws.com/',
      fields: { key, 'Content-Type': contentType },
    })),
    size: async (key) => objects.get(key)?.body.length,
    read: async (key) => objects.get(key)?.body,
    write: async (key, body, contentType) => {
      objects.set(key, { body, contentType });
    },
    remove: async (key) => {
      objects.delete(key);
    },
    presign: async (key, downloadName) =>
      `https://signed.example/${key}${downloadName ? `?download=${downloadName}` : ''}`,
  };
  return { objects, storage };
}

describe('presignUpload', () => {
  const s3 = new S3Client({
    region: 'us-west-2',
    credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' },
  });

  it('limits the POST to the key, 1 byte to 10 MB, the content type and 5 minutes', async () => {
    const before = Date.now();
    const { url, fields } = await presignUpload(
      s3,
      'pictora-dev-images',
      'uploads/sub-1/01JAPKAD0000000000000000AA',
      'image/png',
    );

    expect(url).toContain('pictora-dev-images');
    expect(fields).toMatchObject({
      key: 'uploads/sub-1/01JAPKAD0000000000000000AA',
      'Content-Type': 'image/png',
    });
    const policy = JSON.parse(Buffer.from(fields.Policy ?? '', 'base64').toString('utf8')) as {
      expiration: string;
      conditions: unknown[];
    };
    expect(policy.conditions).toEqual(
      expect.arrayContaining([
        ['content-length-range', 1, MAX_UPLOAD_BYTES],
        ['eq', '$Content-Type', 'image/png'],
        { key: 'uploads/sub-1/01JAPKAD0000000000000000AA' },
        { bucket: 'pictora-dev-images' },
      ]),
    );
    const expiresIn = new Date(policy.expiration).getTime() - before;
    expect(expiresIn).toBeGreaterThan(4 * 60_000);
    expect(expiresIn).toBeLessThanOrEqual(5 * 60_000 + 1000);
  });
});

describe('upload routes', () => {
  const headers = { [SESSION_HEADERS.sub]: 'u', [SESSION_HEADERS.email]: 'u@example.com' };

  it('answer 401 without a session', async () => {
    const start = await uploadsRoute(
      new NextRequest('https://pictora.example.dev/api/uploads', { method: 'POST', body: '{}' }),
    );
    expect(start.status).toBe(401);
    const complete = await completeRoute(
      new NextRequest('https://pictora.example.dev/api/uploads/x/complete', { method: 'POST' }),
      { params: Promise.resolve({ id: 'x' }) },
    );
    expect(complete.status).toBe(401);
  });

  it('answers 400 when the upload request is not JSON', async () => {
    const response = await uploadsRoute(
      new NextRequest('https://pictora.example.dev/api/uploads', {
        method: 'POST',
        body: 'nope',
        headers,
      }),
    );
    expect(response.status).toBe(400);
  });
});

describe('createUpload: request checks', () => {
  const offline = (): UploadsDeps => ({
    client: {
      send: () => Promise.reject(new Error('DynamoDB should not be called')),
    } as unknown as UploadsDeps['client'],
    tableName: 'unused',
    storage: memoryStorage().storage,
    moderate: vi.fn<Moderate>(),
    prepare: prepareUpload,
    now: () => NOW,
    newId: () => '01JAPKAD0000000000000000AA',
  });
  const session: Session = { sub: 'sub-1', email: 'u@example.com', groups: [] };

  it.each([
    [{ contentType: 'application/pdf', size: 1000 }, 'upload_wrong_type', 400],
    [{ contentType: 'image/gif', size: 1000 }, 'upload_wrong_type', 400],
    [{ size: 1000 }, 'upload_wrong_type', 400],
    [{ contentType: 'image/jpeg', size: MAX_UPLOAD_BYTES + 1 }, 'upload_too_large', 413],
    [{ contentType: 'image/jpeg', size: 11 * 1024 * 1024 }, 'upload_too_large', 413],
    [{ contentType: 'image/jpeg', size: 0 }, 'invalid_request', 400],
    [{ contentType: 'image/jpeg', size: 10, extra: true }, 'invalid_request', 400],
  ])('refuses %j with %s', async (input, code, status) => {
    const result = await createUpload(offline(), session, input);
    expect(result).toMatchObject({ status, body: { code } });
    expect(typeof result.body.error).toBe('string');
  });
});

describe.skipIf(!DYNAMODB_ENDPOINT)('uploads with DynamoDB Local', () => {
  const table = localTable('pictora-uploads');
  const { client, tableName } = table;
  let ids = 0;
  let sessions = 0;
  let moderate: ReturnType<typeof vi.fn<Moderate>>;
  let memory: ReturnType<typeof memoryStorage>;

  const nextId = () => `01JAP${String(++ids).padStart(21, '0')}`;
  const deps = (overrides: Partial<UploadsDeps> = {}): UploadsDeps => ({
    client,
    tableName,
    storage: memory.storage,
    moderate,
    prepare: prepareUpload,
    now: () => NOW,
    newId: nextId,
    ...overrides,
  });

  const getItem = async (PK: string, SK: string) =>
    (await client.send(new GetCommand({ TableName: tableName, Key: { PK, SK } }))).Item;
  const query = async (PK: string, prefix: string) =>
    (
      await client.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
          ExpressionAttributeValues: { ':pk': PK, ':prefix': prefix },
        }),
      )
    ).Items ?? [];
  const setProfile = async (sub: string, fields: Record<string, unknown>) => {
    const names = Object.keys(fields);
    await client.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { PK: userPk(sub), SK: PROFILE_SK },
        UpdateExpression: `SET ${names.map((_, i) => `#k${i} = :v${i}`).join(', ')}`,
        ExpressionAttributeNames: Object.fromEntries(names.map((name, i) => [`#k${i}`, name])),
        ExpressionAttributeValues: Object.fromEntries(
          names.map((name, i) => [`:v${i}`, fields[name]]),
        ),
      }),
    );
  };
  const onboardedSession = async (): Promise<Session> => {
    sessions += 1;
    const session = { sub: `up-${sessions}-${Date.now()}`, email: 'u@example.com', groups: [] };
    await setProfile(session.sub, ONBOARDED);
    return session;
  };
  /** Starts an upload and puts the file where the presigned POST would have. */
  const uploaded = async (session: Session, body: Uint8Array) => {
    const result = await createUpload(deps(), session, {
      contentType: 'image/jpeg',
      size: Math.min(body.length, MAX_UPLOAD_BYTES),
    });
    expect(result.status).toBe(200);
    const uploadId = result.body.uploadId as string;
    memory.objects.set(uploadKey(session.sub, uploadId), { body });
    return uploadId;
  };

  beforeAll(() => table.create());
  afterAll(() => table.drop());
  beforeEach(() => {
    moderate = vi.fn<Moderate>(async () => clean);
    memory = memoryStorage();
  });

  describe('createUpload', () => {
    it('returns a presigned POST for uploads/<sub>/<ulid>, costing no points', async () => {
      const session = await onboardedSession();
      const result = await createUpload(deps(), session, {
        contentType: 'image/webp',
        size: 5 * 1024 * 1024,
      });

      expect(result.status).toBe(200);
      const uploadId = result.body.uploadId as string;
      expect(uploadId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(memory.storage.presignUpload).toHaveBeenCalledWith(
        `uploads/${session.sub}/${uploadId}`,
        'image/webp',
      );
      expect(result.body).toMatchObject({
        url: expect.any(String),
        fields: { key: `uploads/${session.sub}/${uploadId}` },
        expiresAt: '2026-10-19T10:05:00.000Z',
      });
      expect(await query(userPk(session.sub), 'USAGE#')).toEqual([]);
    });

    it('needs onboarding first, and refuses suspended accounts and cooldowns', async () => {
      const fresh = { sub: `up-new-${Date.now()}`, email: 'n@example.com', groups: [] };
      const request = { contentType: 'image/png', size: 100 };
      expect(await createUpload(deps(), fresh, request)).toMatchObject({
        status: 403,
        body: { code: 'onboarding_required' },
      });
      const suspended = await onboardedSession();
      await setProfile(suspended.sub, { status: 'suspended' });
      expect(await createUpload(deps(), suspended, request)).toMatchObject({
        body: { code: 'suspended' },
      });
      const cooling = await onboardedSession();
      await setProfile(cooling.sub, { cooldownUntil: '2026-10-20T08:00:00.000Z' });
      expect(await createUpload(deps(), cooling, request)).toMatchObject({
        body: { code: 'cooldown' },
      });
      expect(memory.storage.presignUpload).not.toHaveBeenCalled();
    });

    it('shares the rate window with jobs', async () => {
      const session = await onboardedSession();
      const request = { contentType: 'image/png', size: 100 };
      for (let i = 0; i < 10; i++) {
        expect((await createUpload(deps(), session, request)).status).toBe(200);
      }
      expect(await createUpload(deps(), session, request)).toMatchObject({
        status: 429,
        body: { code: 'rate_limited' },
      });
    });
  });

  describe('completeUpload', () => {
    it('makes an allowed upload version 1 of a new image, as a PNG with a thumbnail', async () => {
      const session = await onboardedSession();
      const uploadId = await uploaded(session, await jpeg(800, 600));

      const result = await completeUpload(deps(), session, uploadId);

      expect(result.status).toBe(201);
      const png = imageKey(session.sub, uploadId, 1);
      const thumb = thumbnailKey(session.sub, uploadId, 1);
      expect(result.body).toEqual({
        image: {
          imageId: uploadId,
          version: 1,
          width: 800,
          height: 600,
          url: `https://signed.example/${png}`,
          downloadUrl: `https://signed.example/${png}?download=pictora-${uploadId}-v1.png`,
        },
      });
      expect(moderate).toHaveBeenCalledTimes(1);
      const moderated = moderate.mock.calls[0]?.[0].image as Uint8Array;
      expect((await sharp(moderated).metadata()).format).toBe('jpeg');

      const stored = memory.objects.get(png);
      expect(stored?.contentType).toBe('image/png');
      expect(await sharp(stored!.body).metadata()).toMatchObject({
        format: 'png',
        width: 800,
        height: 600,
      });
      expect(memory.objects.get(thumb)?.contentType).toBe('image/webp');
      expect(memory.objects.has(uploadKey(session.sub, uploadId))).toBe(false);

      expect(await getItem(userPk(session.sub), imageSk(uploadId))).toMatchObject({
        imageId: uploadId,
        title: UPLOAD_TITLE,
        latestVersion: 1,
        versionCount: 1,
        source: 'upload',
        thumbKey: thumb,
        createdAt: NOW.toISOString(),
      });
      expect(await getItem(userPk(session.sub), versionSk(uploadId, 1))).toMatchObject({
        imageId: uploadId,
        version: 1,
        s3Key: png,
        thumbKey: thumb,
        width: 800,
        height: 600,
        source: 'upload',
        costPoints: 0,
      });
      expect(await query(userPk(session.sub), 'USAGE#')).toEqual([]);
    });

    it('answers with the same image when completed again', async () => {
      const session = await onboardedSession();
      const uploadId = await uploaded(session, await jpeg());
      expect((await completeUpload(deps(), session, uploadId)).status).toBe(201);

      const again = await completeUpload(deps(), session, uploadId);

      expect(again).toMatchObject({ status: 200, body: { image: { imageId: uploadId } } });
      expect(moderate).toHaveBeenCalledTimes(1);
    });

    it('answers 404 for a missing upload or a malformed ID', async () => {
      const session = await onboardedSession();
      expect(await completeUpload(deps(), session, nextId())).toMatchObject({
        status: 404,
        body: { code: 'not_found' },
      });
      expect(await completeUpload(deps(), session, '../../users/x')).toMatchObject({
        status: 404,
      });
      expect(moderate).not.toHaveBeenCalled();
    });

    it("answers 404 for another user's upload, leaving it alone", async () => {
      const owner = await onboardedSession();
      const other = await onboardedSession();
      const uploadId = await uploaded(owner, await jpeg());

      expect(await completeUpload(deps(), other, uploadId)).toMatchObject({ status: 404 });

      expect(memory.objects.has(uploadKey(owner.sub, uploadId))).toBe(true);
      expect(await getItem(userPk(other.sub), imageSk(uploadId))).toBeUndefined();
      expect(await getItem(userPk(owner.sub), imageSk(uploadId))).toBeUndefined();
    });

    it('deletes an upload over 10 MB', async () => {
      const session = await onboardedSession();
      const uploadId = await uploaded(session, new Uint8Array(MAX_UPLOAD_BYTES + 1));

      expect(await completeUpload(deps(), session, uploadId)).toMatchObject({
        status: 413,
        body: { code: 'upload_too_large' },
      });
      expect(memory.objects.has(uploadKey(session.sub, uploadId))).toBe(false);
      expect(moderate).not.toHaveBeenCalled();
    });

    it('deletes an upload that is not an image', async () => {
      const session = await onboardedSession();
      const pdf = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n');
      const uploadId = await uploaded(session, pdf);

      expect(await completeUpload(deps(), session, uploadId)).toMatchObject({
        status: 400,
        body: { code: 'not_an_image' },
      });
      expect(memory.objects.has(uploadKey(session.sub, uploadId))).toBe(false);
      expect(await getItem(userPk(session.sub), imageSk(uploadId))).toBeUndefined();
      expect(moderate).not.toHaveBeenCalled();
    });

    it('deletes a flagged upload and counts it as a block, cooling down at the third', async () => {
      const session = await onboardedSession();
      moderate.mockResolvedValue(sexual);

      for (let block = 1; block <= 3; block++) {
        const uploadId = await uploaded(session, await jpeg());
        const result = await completeUpload(deps(), session, uploadId);

        expect(result).toMatchObject({ status: 422, body: { code: 'blocked' } });
        expect(memory.objects.has(uploadKey(session.sub, uploadId))).toBe(false);
        expect(memory.objects.has(imageKey(session.sub, uploadId, 1))).toBe(false);
        expect(await getItem(userPk(session.sub), imageSk(uploadId))).toBeUndefined();
        const profile = await getItem(userPk(session.sub), PROFILE_SK);
        expect(profile?.cooldownUntil).toBe(block < 3 ? undefined : '2026-10-20T10:00:00.000Z');
      }

      const blocks = await query(userPk(session.sub), 'BLOCK#');
      expect(blocks).toHaveLength(3);
      expect(blocks[0]).toMatchObject({
        stage: 'image',
        category: 'sexual',
        uploadId: expect.any(String),
        createdAt: NOW.toISOString(),
      });
      expect(blocks[0]?.jobId).toBeUndefined();
      const log = (await query('MODLOG#2026-10-19', '01')).filter(
        (entry) => entry.userId === session.sub,
      );
      expect(log).toHaveLength(3);
      expect(log[0]).toMatchObject({ type: 'block', stage: 'image', category: 'sexual' });
    });

    it('keeps the upload and answers 503 when moderation is down', async () => {
      const session = await onboardedSession();
      const uploadId = await uploaded(session, await jpeg());
      moderate.mockRejectedValue(new Error('moderation unavailable'));
      vi.spyOn(console, 'error').mockImplementation(() => {});

      expect(await completeUpload(deps(), session, uploadId)).toMatchObject({
        status: 503,
        body: { code: 'moderation_failed' },
      });
      expect(memory.objects.has(uploadKey(session.sub, uploadId))).toBe(true);
      expect(await query(userPk(session.sub), 'BLOCK#')).toEqual([]);

      moderate.mockResolvedValue(clean);
      expect((await completeUpload(deps(), session, uploadId)).status).toBe(201);
    });

    it('refuses suspended accounts', async () => {
      const session = await onboardedSession();
      const uploadId = await uploaded(session, await jpeg());
      await setProfile(session.sub, { status: 'suspended' });

      expect(await completeUpload(deps(), session, uploadId)).toMatchObject({
        status: 403,
        body: { code: 'suspended' },
      });
      expect(moderate).not.toHaveBeenCalled();
    });
  });
});
