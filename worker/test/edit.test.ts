import { GetObjectCommand, NoSuchKey, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import {
  JOB_ERROR_MESSAGES,
  JOB_SK,
  PROFILE_SK,
  imageKey,
  imageSk,
  jobPk,
  thumbnailKey,
  uploadKey,
  usageSk,
  userPk,
  versionSk,
  type EditJobRequest,
  type ModelConfig,
} from '@pictora/core';
import { MockProvider, type ImageProvider, type ImageRequest } from '@pictora/providers';
import { mockClient } from 'aws-sdk-client-mock';
import sharp from 'sharp';
import { ulid } from 'ulid';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claimVersion, completeEditJob } from '../src/job_store.js';
import { buildEditRequest, processJob } from '../src/pipeline.js';
import { DYNAMODB_ENDPOINT, localTable } from './dynamodb_local.js';
import { edit, getItem, newUser, pipelineDeps, pngOf, seedJob } from './helpers.js';

const s3 = mockClient(S3Client);

describe('buildEditRequest', () => {
  it('sends the instruction, the parent and the references for one image', () => {
    const signal = new AbortController().signal;
    const parent = new Uint8Array([1]);
    const reference = new Uint8Array([2]);
    const request = buildEditRequest(
      edit('01JAAAAAAAAAAAAAAAAAAAAAAA', { instruction: 'Add stars', quality: 'high' }),
      { parent, references: [reference], aspect: '3:2' },
      signal,
    );
    expect(request).toEqual({
      prompt: 'Add stars',
      aspect: '3:2',
      quality: 'high',
      count: 1,
      inputImage: parent,
      referenceImages: [reference],
      signal,
    });
  });

  it('leaves out references when there are none', () => {
    const request = buildEditRequest(
      edit('01JAAAAAAAAAAAAAAAAAAAAAAA'),
      { parent: new Uint8Array([1]), references: [], aspect: '1:1' },
      new AbortController().signal,
    );
    expect(request).not.toHaveProperty('referenceImages');
  });
});

/** A mock adapter that records every edit request. */
function recordingMock(): { provider: ImageProvider; edits: ImageRequest[] } {
  const mock = new MockProvider({ delayMs: 0 });
  const edits: ImageRequest[] = [];
  return {
    provider: {
      generate: (m: ModelConfig, req: ImageRequest) => mock.generate(m, req),
      edit: (m: ModelConfig, req: ImageRequest) => {
        edits.push(req);
        return mock.edit(m, req);
      },
    },
    edits,
  };
}

describe.skipIf(!DYNAMODB_ENDPOINT)('edit jobs', () => {
  let table: ReturnType<typeof localTable>;
  /** What the mocked bucket holds, by key. */
  let objects: Map<string, Uint8Array>;

  beforeEach(async () => {
    table = localTable('pictora-edit');
    await table.create();
    objects = new Map();
    s3.reset();
    s3.on(PutObjectCommand).callsFake((input: { Key: string; Body: Uint8Array }) => {
      objects.set(input.Key, input.Body);
      return {};
    });
    s3.on(GetObjectCommand).callsFake((input: { Key: string }) => {
      const bytes = objects.get(input.Key);
      if (!bytes) throw new NoSuchKey({ message: 'NoSuchKey', $metadata: {} });
      return { Body: { transformToByteArray: async () => bytes } };
    });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await table.drop();
  });

  const item = (pk: string, sk: string) => getItem(table.client, table.tableName, pk, sk);

  /** A generated image's `IMG#` and `VER#…#1` items and its PNG, as the generate pipeline leaves them. */
  async function seedImage(
    sub: string,
    options: { width?: number; height?: number; aspect?: string } = {},
  ): Promise<{ imageId: string; png: Uint8Array }> {
    const imageId = ulid();
    const width = options.width ?? 64;
    const height = options.height ?? 64;
    const png = await pngOf(width, height);
    objects.set(imageKey(sub, imageId, 1), png);
    await table.client.send(
      new PutCommand({
        TableName: table.tableName,
        Item: {
          PK: userPk(sub),
          SK: imageSk(imageId),
          imageId,
          title: 'A lighthouse at dusk',
          latestVersion: 1,
          versionCount: 1,
          thumbKey: thumbnailKey(sub, imageId, 1),
        },
      }),
    );
    await table.client.send(
      new PutCommand({
        TableName: table.tableName,
        Item: {
          PK: userPk(sub),
          SK: versionSk(imageId, 1),
          imageId,
          version: 1,
          s3Key: imageKey(sub, imageId, 1),
          thumbKey: thumbnailKey(sub, imageId, 1),
          width,
          height,
          ...(options.aspect ? { aspect: options.aspect } : {}),
          prompt: 'A lighthouse at dusk',
        },
      }),
    );
    return { imageId, png };
  }

  async function runEdit(sub: string, request: EditJobRequest, adapter?: ImageProvider) {
    const job = await seedJob(table.client, table.tableName, sub, { request });
    const deps = pipelineDeps(
      table.client,
      table.tableName,
      adapter ?? new MockProvider({ delayMs: 0 }),
    );
    const outcome = await processJob(deps, job.jobId);
    return { outcome, job: await item(jobPk(job.jobId), JOB_SK) };
  }

  it('stores the result as version 2 with its parent and instruction, and settles the point', async () => {
    const sub = newUser();
    const { imageId } = await seedImage(sub, { aspect: '1:1' });
    const { outcome, job } = await runEdit(sub, edit(imageId));
    expect(outcome).toBe('succeeded');
    expect(job).toMatchObject({
      status: 'succeeded',
      type: 'edit',
      pointsCharged: 1,
      images: [{ imageId, version: 2, s3Key: imageKey(sub, imageId, 2) }],
    });
    expect(await item(userPk(sub), versionSk(imageId, 2))).toMatchObject({
      imageId,
      version: 2,
      parentVersion: 1,
      editInstruction: 'Make it night',
      modelId: 'mock',
      quality: 'draft',
      aspect: '1:1',
      s3Key: imageKey(sub, imageId, 2),
      thumbKey: thumbnailKey(sub, imageId, 2),
      costPoints: 1,
    });
    expect(await item(userPk(sub), imageSk(imageId))).toMatchObject({
      latestVersion: 2,
      versionCount: 2,
      thumbKey: thumbnailKey(sub, imageId, 2),
      title: 'A lighthouse at dusk',
    });
    expect(objects.has(imageKey(sub, imageId, 2))).toBe(true);
    expect(objects.has(thumbnailKey(sub, imageId, 2))).toBe(true);
    expect((await item(userPk(sub), PROFILE_SK))?.activeJobs).toBe(0);
    expect((await item(userPk(sub), usageSk('2026-10-15')))?.used).toBe(1);
  });

  it('numbers versions in order and branches from an earlier one without touching it', async () => {
    const sub = newUser();
    const { imageId, png } = await seedImage(sub);
    const versionOne = await item(userPk(sub), versionSk(imageId, 1));

    await runEdit(sub, edit(imageId, { instruction: 'Make it night' }));
    await runEdit(sub, edit(imageId, { parentVersion: 2, instruction: 'Add stars' }));
    const { outcome } = await runEdit(
      sub,
      edit(imageId, { parentVersion: 1, instruction: 'Add snow' }),
    );
    expect(outcome).toBe('succeeded');

    expect(await item(userPk(sub), versionSk(imageId, 3))).toMatchObject({
      parentVersion: 2,
      editInstruction: 'Add stars',
    });
    expect(await item(userPk(sub), versionSk(imageId, 4))).toMatchObject({
      parentVersion: 1,
      editInstruction: 'Add snow',
    });
    expect(await item(userPk(sub), imageSk(imageId))).toMatchObject({
      latestVersion: 4,
      versionCount: 4,
    });
    // EDIT-3: the original is never overwritten.
    expect(await item(userPk(sub), versionSk(imageId, 1))).toEqual(versionOne);
    expect(objects.get(imageKey(sub, imageId, 1))).toBe(png);
  });

  it('sends the parent PNG and each reference to the adapter', async () => {
    const sub = newUser();
    const { imageId, png } = await seedImage(sub);
    const other = await seedImage(sub, { width: 32, height: 48 });
    const uploadId = ulid();
    const jpeg = new Uint8Array(
      await sharp({
        create: { width: 40, height: 20, channels: 3, background: { r: 200, g: 10, b: 10 } },
      })
        .jpeg()
        .toBuffer(),
    );
    objects.set(uploadKey(sub, uploadId), jpeg);

    const recorder = recordingMock();
    const { outcome } = await runEdit(
      sub,
      edit(imageId, {
        referenceKeys: [imageKey(sub, other.imageId, 1), uploadKey(sub, uploadId)],
      }),
      recorder.provider,
    );
    expect(outcome).toBe('succeeded');
    const [sent] = recorder.edits;
    expect(sent?.prompt).toBe('Make it night');
    expect(sent?.inputImage).toEqual(png);
    expect(sent?.referenceImages?.[0]).toEqual(other.png);
    // The raw upload is decoded and sent as a PNG, as an upload would be stored.
    const converted = await sharp(sent?.referenceImages?.[1]).metadata();
    expect(converted).toMatchObject({ format: 'png', width: 40, height: 20 });
  });

  it("asks for the aspect nearest the parent's shape when it has none", async () => {
    const sub = newUser();
    const { imageId } = await seedImage(sub, { width: 192, height: 108 });
    const recorder = recordingMock();
    await runEdit(sub, edit(imageId), recorder.provider);
    expect(recorder.edits[0]?.aspect).toBe('16:9');
    expect(await item(userPk(sub), versionSk(imageId, 2))).toMatchObject({ aspect: '16:9' });
  });

  it('refunds a failed edit and leaves the image as it was', async () => {
    const sub = newUser();
    const { imageId } = await seedImage(sub);
    const before = await item(userPk(sub), imageSk(imageId));
    const { outcome, job } = await runEdit(sub, edit(imageId, { instruction: 'Fail __fail__' }));
    expect(outcome).toBe('failed');
    expect(job).toMatchObject({ status: 'failed', pointsCharged: 0 });
    expect((await item(userPk(sub), usageSk('2026-10-15')))?.used).toBe(0);
    expect((await item(userPk(sub), PROFILE_SK))?.activeJobs).toBe(0);
    expect(await item(userPk(sub), versionSk(imageId, 2))).toBeUndefined();
    expect(await item(userPk(sub), imageSk(imageId))).toEqual(before);
  });

  it('fails and refunds without calling the provider when the parent is gone', async () => {
    const sub = newUser();
    const recorder = recordingMock();
    const { outcome, job } = await runEdit(sub, edit(ulid()), recorder.provider);
    expect(outcome).toBe('failed');
    expect(job).toMatchObject({
      status: 'failed',
      error: { code: 'source_missing', message: JOB_ERROR_MESSAGES.source_missing },
    });
    expect(recorder.edits).toHaveLength(0);
    expect((await item(userPk(sub), usageSk('2026-10-15')))?.used).toBe(0);
  });

  it("fails and refunds when a reference is another user's or has expired", async () => {
    const sub = newUser();
    const { imageId } = await seedImage(sub);
    const stranger = newUser();
    const theirs = await seedImage(stranger);
    const recorder = recordingMock();

    for (const key of [imageKey(stranger, theirs.imageId, 1), uploadKey(sub, ulid())]) {
      const { outcome, job } = await runEdit(
        sub,
        edit(imageId, { referenceKeys: [key] }),
        recorder.provider,
      );
      expect(outcome).toBe('failed');
      expect(job).toMatchObject({ error: { code: 'source_missing' } });
    }
    expect(recorder.edits).toHaveLength(0);
  });

  it('gives concurrent edits their own version numbers and keeps the highest as the latest', async () => {
    const sub = newUser();
    const { imageId } = await seedImage(sub);
    const ctx = { client: table.client, tableName: table.tableName };
    expect(await claimVersion(ctx, sub, imageId)).toBe(2);
    expect(await claimVersion(ctx, sub, imageId)).toBe(3);
    expect(await claimVersion(ctx, sub, ulid())).toBeUndefined();

    // Version 3 finishes first, then version 2.
    for (const version of [3, 2]) {
      const request = edit(imageId);
      const job = await seedJob(table.client, table.tableName, sub, {
        request,
        status: 'running',
      });
      const result = await completeEditJob(ctx, {
        job,
        request,
        image: {
          imageId,
          version,
          s3Key: imageKey(sub, imageId, version),
          thumbKey: thumbnailKey(sub, imageId, version),
          width: 64,
          height: 64,
          costPoints: 1,
        },
        aspect: '1:1',
        settlement: { chargedPoints: 1, usageDelta: 0 },
        providerCostCents: 1,
        now: new Date('2026-10-15T12:00:30.000Z'),
      });
      expect(result).toBe('completed');
    }
    expect(await item(userPk(sub), imageSk(imageId))).toMatchObject({
      latestVersion: 3,
      versionCount: 3,
      thumbKey: thumbnailKey(sub, imageId, 3),
    });
  });

  it('reports an image deleted while its edit ran, writing no version', async () => {
    const sub = newUser();
    const request = edit(ulid());
    const job = await seedJob(table.client, table.tableName, sub, { request, status: 'running' });
    const ctx = { client: table.client, tableName: table.tableName };
    const result = await completeEditJob(ctx, {
      job,
      request,
      image: {
        imageId: request.imageId,
        version: 2,
        s3Key: imageKey(sub, request.imageId, 2),
        thumbKey: thumbnailKey(sub, request.imageId, 2),
        width: 64,
        height: 64,
        costPoints: 1,
      },
      aspect: '1:1',
      settlement: { chargedPoints: 1, usageDelta: 0 },
      providerCostCents: 1,
      now: new Date('2026-10-15T12:00:30.000Z'),
    });
    expect(result).toBe('image_gone');
    expect(await item(userPk(sub), versionSk(request.imageId, 2))).toBeUndefined();
  });
});
