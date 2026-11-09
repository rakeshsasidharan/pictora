import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
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
  type ToolJobRequest,
} from '@pictora/core';
import { BedrockProvider, MockProvider, createProviderFactory } from '@pictora/providers';
import { mockClient } from 'aws-sdk-client-mock';
import sharp from 'sharp';
import { ulid } from 'ulid';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { processJob, type ModerateRequest } from '../src/pipeline.js';
import { DYNAMODB_ENDPOINT, localTable } from './dynamodb_local.js';
import { getItem, newUser, pipelineDeps, pngOf, seedJob } from './helpers.js';

const s3 = mockClient(S3Client);
const bedrock = mockClient(BedrockRuntimeClient);

/** Each tool's Bedrock model and its price in points (one point a cent of list price). */
const TOOL_MODELS = {
  upscale: { modelId: 'stable-fast-upscale', points: 3 },
  conservative: { modelId: 'stable-conservative-upscale', points: 40 },
  creative: { modelId: 'stable-creative-upscale', points: 60 },
  removeBackground: { modelId: 'stable-image-remove-background', points: 7 },
  erase: { modelId: 'stable-image-erase-object', points: 7 },
  outpaint: { modelId: 'stable-outpaint', points: 6 },
} as const;

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

/** The JSON body of each `InvokeModel` call so far, with its model ID. */
function sentCalls(): { modelId: string; body: Record<string, unknown> }[] {
  return bedrock.commandCalls(InvokeModelCommand).map((call) => ({
    modelId: String(call.args[0].input.modelId),
    body: JSON.parse(String(call.args[0].input.body)) as Record<string, unknown>,
  }));
}

function answerWith(png: Uint8Array) {
  bedrock.on(InvokeModelCommand).resolves({
    body: new TextEncoder().encode(
      JSON.stringify({ images: [base64(png)], seeds: [7], finish_reasons: [null] }),
    ) as never,
    contentType: 'application/json',
    $metadata: { requestId: 'req-1' },
  });
}

describe.skipIf(!DYNAMODB_ENDPOINT)('tool jobs', () => {
  let table: ReturnType<typeof localTable>;
  let objects: Map<string, Uint8Array>;
  const bedrockProvider = new BedrockProvider({
    client: new BedrockRuntimeClient({
      region: 'us-west-2',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    }),
  });

  beforeEach(async () => {
    table = localTable('pictora-tool');
    await table.create();
    objects = new Map();
    s3.reset();
    bedrock.reset();
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

  /** An image with versions 1 and 2, as generate and an edit leave them; version 2 is the latest. */
  async function seedImage(sub: string, size = { width: 128, height: 96 }) {
    const imageId = ulid();
    const png = await pngOf(size.width, size.height);
    await table.client.send(
      new PutCommand({
        TableName: table.tableName,
        Item: {
          PK: userPk(sub),
          SK: imageSk(imageId),
          imageId,
          title: 'A lighthouse at dusk',
          latestVersion: 2,
          versionCount: 2,
          thumbKey: thumbnailKey(sub, imageId, 2),
        },
      }),
    );
    for (const version of [1, 2]) {
      objects.set(imageKey(sub, imageId, version), png);
      await table.client.send(
        new PutCommand({
          TableName: table.tableName,
          Item: {
            PK: userPk(sub),
            SK: versionSk(imageId, version),
            imageId,
            version,
            s3Key: imageKey(sub, imageId, version),
            thumbKey: thumbnailKey(sub, imageId, version),
            width: size.width,
            height: size.height,
            aspect: '4:5',
            ...(version === 1 ? { prompt: 'A lighthouse at dusk' } : { parentVersion: 1 }),
          },
        }),
      );
    }
    return { imageId, png };
  }

  async function runTool(
    sub: string,
    request: ToolJobRequest,
    options: { modelId: string; points: number; moderate?: ModerateRequest },
  ) {
    const job = await seedJob(table.client, table.tableName, sub, {
      request,
      modelId: options.modelId,
      provider: options.modelId === 'mock' ? 'mock' : 'bedrock',
      pointsReserved: options.points,
    });
    const deps = pipelineDeps(table.client, table.tableName, new MockProvider({ delayMs: 0 }), {
      provider: createProviderFactory({
        adapters: { bedrock: () => bedrockProvider, mock: () => new MockProvider({ delayMs: 0 }) },
        retry: { delayMs: 0, jitterMs: 0 },
      }),
      ...(options.moderate ? { moderate: options.moderate } : {}),
    });
    const outcome = await processJob(deps, job.jobId);
    return { outcome, job: await item(jobPk(job.jobId), JOB_SK) };
  }

  it('upscales a version into the next version, with the tool recorded and the points settled', async () => {
    const sub = newUser();
    const { imageId, png } = await seedImage(sub);
    const upscaled = await pngOf(512, 384);
    answerWith(upscaled);

    const { outcome, job } = await runTool(
      sub,
      { type: 'tool', imageId, version: 1, tool: 'upscale', params: { mode: 'fast' } },
      TOOL_MODELS.upscale,
    );

    expect(outcome).toBe('succeeded');
    expect(sentCalls()).toEqual([
      {
        modelId: 'us.stability.stable-fast-upscale-v1:0',
        body: { image: base64(png), output_format: 'png' },
      },
    ]);
    expect(job).toMatchObject({
      status: 'succeeded',
      type: 'tool',
      pointsCharged: 3,
      providerCostCents: 3,
      images: [{ imageId, version: 3, s3Key: imageKey(sub, imageId, 3) }],
    });
    const version = await item(userPk(sub), versionSk(imageId, 3));
    expect(version).toMatchObject({
      version: 3,
      parentVersion: 1,
      tool: 'upscale-fast',
      modelId: 'stable-fast-upscale',
      width: 512,
      height: 384,
      aspect: '3:2',
      costPoints: 3,
    });
    expect(version).not.toHaveProperty('editInstruction');
    expect(version).not.toHaveProperty('quality');
    expect(objects.get(imageKey(sub, imageId, 3))).toEqual(upscaled);
    expect(objects.has(thumbnailKey(sub, imageId, 3))).toBe(true);
    expect(await item(userPk(sub), imageSk(imageId))).toMatchObject({
      latestVersion: 3,
      versionCount: 3,
      thumbKey: thumbnailKey(sub, imageId, 3),
    });
    expect((await item(userPk(sub), PROFILE_SK))?.activeJobs).toBe(0);
    expect((await item(userPk(sub), usageSk('2026-10-15')))?.used).toBe(3);
  });

  it('sends the conservative and creative upscales their prompt, empty when none was given', async () => {
    const sub = newUser();
    const { imageId } = await seedImage(sub);
    answerWith(await pngOf(256, 192));
    await runTool(
      sub,
      {
        type: 'tool',
        imageId,
        version: 2,
        tool: 'upscale',
        params: { mode: 'creative', prompt: ' A lighthouse ' },
      },
      TOOL_MODELS.creative,
    );
    await runTool(
      sub,
      { type: 'tool', imageId, version: 2, tool: 'upscale', params: { mode: 'conservative' } },
      TOOL_MODELS.conservative,
    );
    const [creative, conservative] = sentCalls();
    expect(creative?.modelId).toBe('us.stability.stable-creative-upscale-v1:0');
    expect(creative?.body.prompt).toBe('A lighthouse');
    expect(conservative?.modelId).toBe('us.stability.stable-conservative-upscale-v1:0');
    expect(conservative?.body.prompt).toBe('');
    expect(await item(userPk(sub), versionSk(imageId, 3))).toMatchObject({
      tool: 'upscale-creative',
      toolPrompt: 'A lighthouse',
      parentVersion: 2,
    });
  });

  it('removes the background into a transparent PNG, marked transparent on the version', async () => {
    const sub = newUser();
    const { imageId } = await seedImage(sub);
    const cutOut = new Uint8Array(
      await sharp({
        create: { width: 128, height: 96, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
      })
        .png()
        .toBuffer(),
    );
    answerWith(cutOut);
    const { outcome } = await runTool(
      sub,
      { type: 'tool', imageId, version: 2, tool: 'remove-background', params: {} },
      TOOL_MODELS.removeBackground,
    );
    expect(outcome).toBe('succeeded');
    expect(sentCalls()[0]?.modelId).toBe('us.stability.stable-image-remove-background-v1:0');
    const stored = objects.get(imageKey(sub, imageId, 3));
    expect((await sharp(stored!).metadata()).hasAlpha).toBe(true);
    expect(await item(userPk(sub), versionSk(imageId, 3))).toMatchObject({
      tool: 'remove-background',
      transparentBackground: true,
    });
  });

  it('erases with the drawn mask, encoded black and white at the image size', async () => {
    const sub = newUser();
    const { imageId } = await seedImage(sub);
    const uploadId = ulid();
    // The browser draws the mask at a smaller size: white strokes on black.
    const drawn = new Uint8Array(
      await sharp({ create: { width: 64, height: 48, channels: 3, background: '#000000' } })
        .composite([
          {
            input: await sharp({
              create: { width: 16, height: 16, channels: 3, background: '#ffffff' },
            })
              .png()
              .toBuffer(),
            left: 0,
            top: 0,
          },
        ])
        .png()
        .toBuffer(),
    );
    objects.set(uploadKey(sub, uploadId), drawn);
    answerWith(await pngOf(128, 96));

    const { outcome } = await runTool(
      sub,
      {
        type: 'tool',
        imageId,
        version: 2,
        tool: 'erase',
        params: { maskKey: uploadKey(sub, uploadId), growMask: 3 },
      },
      TOOL_MODELS.erase,
    );

    expect(outcome).toBe('succeeded');
    const [call] = sentCalls();
    expect(call?.modelId).toBe('us.stability.stable-image-erase-object-v1:0');
    expect(call?.body.grow_mask).toBe(3);
    const mask = Buffer.from(String(call?.body.mask), 'base64');
    const { data, info } = await sharp(mask).raw().toBuffer({ resolveWithObject: true });
    expect([info.width, info.height]).toEqual([128, 96]);
    expect(new Set(data)).toEqual(new Set([0, 255]));
    const at = (x: number, y: number) => data[(y * info.width + x) * info.channels];
    expect(at(5, 5)).toBe(255);
    expect(at(100, 80)).toBe(0);
  });

  it('outpaints by the sides asked for', async () => {
    const sub = newUser();
    const { imageId } = await seedImage(sub);
    answerWith(await pngOf(128 + 200, 96));
    const { outcome } = await runTool(
      sub,
      {
        type: 'tool',
        imageId,
        version: 2,
        tool: 'outpaint',
        params: { left: 0, right: 200, up: 0, down: 0, prompt: 'more coastline' },
      },
      TOOL_MODELS.outpaint,
    );
    expect(outcome).toBe('succeeded');
    expect(sentCalls()[0]?.body).toMatchObject({
      left: 0,
      right: 200,
      up: 0,
      down: 0,
      prompt: 'more coastline',
    });
    expect(await item(userPk(sub), versionSk(imageId, 3))).toMatchObject({
      tool: 'outpaint',
      width: 328,
      height: 96,
      aspect: '16:9',
    });
  });

  it('scales a large version down to the tool’s limits before sending it', async () => {
    const sub = newUser();
    const { imageId } = await seedImage(sub, { width: 2048, height: 2048 });
    answerWith(await pngOf(256, 256));
    await runTool(
      sub,
      { type: 'tool', imageId, version: 2, tool: 'upscale', params: { mode: 'fast' } },
      TOOL_MODELS.upscale,
    );
    const sent = Buffer.from(String(sentCalls()[0]?.body.image), 'base64');
    expect(await sharp(sent).metadata()).toMatchObject({ width: 1024, height: 1024 });
  });

  it('refunds in full when the tool call fails, and records no version', async () => {
    const sub = newUser();
    const { imageId } = await seedImage(sub);
    bedrock.on(InvokeModelCommand).rejects(new Error('Bedrock is down'));
    const { outcome, job } = await runTool(
      sub,
      { type: 'tool', imageId, version: 2, tool: 'upscale', params: { mode: 'fast' } },
      TOOL_MODELS.upscale,
    );
    expect(outcome).toBe('failed');
    expect(job).toMatchObject({
      status: 'failed',
      error: { code: 'provider_error', message: JOB_ERROR_MESSAGES.provider_error },
    });
    expect((await item(userPk(sub), usageSk('2026-10-15')))?.used).toBe(0);
    expect((await item(userPk(sub), PROFILE_SK))?.activeJobs).toBe(0);
    expect(await item(userPk(sub), versionSk(imageId, 3))).toBeUndefined();
    expect(await item(userPk(sub), imageSk(imageId))).toMatchObject({ latestVersion: 2 });
  });

  it('blocks and refunds a content filter refusal', async () => {
    const sub = newUser();
    const { imageId } = await seedImage(sub);
    bedrock.on(InvokeModelCommand).resolves({
      body: new TextEncoder().encode(
        JSON.stringify({ images: [''], finish_reasons: ['Filter reason: output image'] }),
      ) as never,
      $metadata: {},
    });
    const { outcome, job } = await runTool(
      sub,
      { type: 'tool', imageId, version: 2, tool: 'remove-background', params: {} },
      TOOL_MODELS.removeBackground,
    );
    expect(outcome).toBe('blocked');
    expect(job).toMatchObject({ status: 'blocked', error: { code: 'blocked' } });
    expect((await item(userPk(sub), usageSk('2026-10-15')))?.used).toBe(0);
  });

  it('fails with source_missing and a refund when the mask upload has expired, before any call', async () => {
    const sub = newUser();
    const { imageId } = await seedImage(sub);
    const { outcome, job } = await runTool(
      sub,
      {
        type: 'tool',
        imageId,
        version: 2,
        tool: 'erase',
        params: { maskKey: uploadKey(sub, ulid()) },
      },
      TOOL_MODELS.erase,
    );
    expect(outcome).toBe('failed');
    expect(job).toMatchObject({ error: { code: 'source_missing' } });
    expect(sentCalls()).toEqual([]);
    expect((await item(userPk(sub), usageSk('2026-10-15')))?.used).toBe(0);
  });

  it('fails with unsupported_image and a refund for a version too small for the tool', async () => {
    const sub = newUser();
    const { imageId } = await seedImage(sub, { width: 40, height: 40 });
    const { outcome, job } = await runTool(
      sub,
      { type: 'tool', imageId, version: 2, tool: 'remove-background', params: {} },
      TOOL_MODELS.removeBackground,
    );
    expect(outcome).toBe('failed');
    expect(job).toMatchObject({ error: { code: 'unsupported_image' } });
    expect(sentCalls()).toEqual([]);
  });

  it('moderates the prompt and the source image, and blocks a flagged one with a refund', async () => {
    const sub = newUser();
    const { imageId, png } = await seedImage(sub);
    const seen: { prompt: string; inputImage?: Uint8Array }[] = [];
    const moderate: ModerateRequest = async ({ request }) => {
      seen.push(request);
      return { flagged: true, category: 'violence/graphic', stage: 'image' };
    };
    const { outcome } = await runTool(
      sub,
      {
        type: 'tool',
        imageId,
        version: 2,
        tool: 'outpaint',
        params: { left: 10, right: 0, up: 0, down: 0, prompt: 'more sea' },
      },
      { ...TOOL_MODELS.outpaint, moderate },
    );
    expect(outcome).toBe('blocked');
    expect(seen).toEqual([{ prompt: 'more sea', inputImage: png }]);
    expect(sentCalls()).toEqual([]);
  });

  it('runs a tool on the Mock with no provider spend', async () => {
    const sub = newUser();
    const { imageId } = await seedImage(sub);
    const { outcome } = await runTool(
      sub,
      { type: 'tool', imageId, version: 2, tool: 'upscale', params: { mode: 'fast' } },
      { modelId: 'mock', points: 1 },
    );
    expect(outcome).toBe('succeeded');
    expect(sentCalls()).toEqual([]);
    expect(await item(userPk(sub), versionSk(imageId, 3))).toMatchObject({
      tool: 'upscale-fast',
      modelId: 'mock',
      width: 256,
      height: 192,
    });
  });
});
