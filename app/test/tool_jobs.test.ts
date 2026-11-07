import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import {
  JOB_SK,
  PLATFORM_PK,
  PROFILE_SK,
  TESTERS_GROUP,
  TOS_VERSION,
  imageKey,
  imageSk,
  jobPk,
  loadSeedRegistry,
  spendSk,
  uploadKey,
  usageSk,
  userPk,
  versionSk,
  type ToolJobRequest,
} from '@pictora/core';
import { modelsAvailableIn } from '@pictora/core/registry-store';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJob, type JobsDeps } from '../src/lib/jobs';
import type { Session } from '../src/lib/session';
import { DYNAMODB_ENDPOINT, localTable } from './dynamodb_local';

const devModels = modelsAvailableIn(loadSeedRegistry(), 'dev');
const IMAGE_ID = '01JAAAAAAAAAAAAAAAAAAAAAAA';
const MASK_ID = '01JBBBBBBBBBBBBBBBBBBBBBBB';

function upscale(mode: 'fast' | 'conservative' | 'creative' = 'fast'): ToolJobRequest {
  return { type: 'tool', imageId: IMAGE_ID, version: 1, tool: 'upscale', params: { mode } };
}

describe.skipIf(!DYNAMODB_ENDPOINT)('tool jobs against DynamoDB Local', () => {
  const table = localTable('pictora-tool-jobs');
  const { client, tableName } = table;
  let sessions = 0;
  let ids = 0;
  let enqueue: ReturnType<typeof vi.fn<JobsDeps['enqueue']>>;
  let uploads: Map<string, number>;

  const deps = (overrides: Partial<JobsDeps> = {}): JobsDeps => ({
    client,
    tableName,
    models: async () => devModels,
    hasQueue: () => true,
    enqueue,
    presign: async (key) => `https://signed.example/${key}`,
    objectSize: async (key) => uploads.get(key),
    defaultDailyPoints: 100,
    spendCapCents: 2000,
    now: () => new Date('2026-10-15T12:00:00Z'),
    newJobId: () => `01J${String(++ids).padStart(23, '0')}`,
    ...overrides,
  });

  const getItem = async (PK: string, SK: string) =>
    (await client.send(new GetCommand({ TableName: tableName, Key: { PK, SK } }))).Item;
  const put = (item: Record<string, unknown>) =>
    client.send(new PutCommand({ TableName: tableName, Item: item }));

  /** An onboarded user with version 1 of `IMAGE_ID`, 1024×1024 unless asked otherwise. */
  async function userWithImage(
    options: { groups?: string[]; width?: number; height?: number } = {},
  ): Promise<Session> {
    sessions += 1;
    const session: Session = {
      sub: `tool-user-${sessions}-${Date.now()}`,
      email: 'user@example.com',
      groups: options.groups ?? [],
    };
    await put({
      PK: userPk(session.sub),
      SK: PROFILE_SK,
      email: session.email,
      createdAt: '2026-10-14T09:00:00.000Z',
      status: 'active',
      activeJobs: 0,
      tosAcceptedAt: '2026-10-14T09:00:00.000Z',
      tosVersion: TOS_VERSION,
      ageConfirmed: true,
    });
    await put({
      PK: userPk(session.sub),
      SK: imageSk(IMAGE_ID),
      imageId: IMAGE_ID,
      latestVersion: 1,
    });
    await put({
      PK: userPk(session.sub),
      SK: versionSk(IMAGE_ID, 1),
      imageId: IMAGE_ID,
      version: 1,
      s3Key: imageKey(session.sub, IMAGE_ID, 1),
      width: options.width ?? 1024,
      height: options.height ?? 1024,
    });
    return session;
  }

  beforeAll(() => table.create());
  afterAll(() => table.drop());
  beforeEach(() => {
    enqueue = vi.fn<JobsDeps['enqueue']>(async () => undefined);
    uploads = new Map();
  });

  it.each([
    ['fast', 'stable-fast-upscale', 3],
    ['conservative', 'stable-conservative-upscale', 40],
    ['creative', 'stable-creative-upscale', 60],
  ] as const)(
    'queues a %s upscale on the Bedrock queue at its price',
    async (mode, modelId, points) => {
      const session = await userWithImage();
      const request = upscale(mode);
      const result = await createJob(deps(), session, request);
      expect(result.status).toBe(202);
      const { jobId } = result.body as { jobId: string };
      expect(result.body).toEqual({ jobId, status: 'queued', pointsReserved: points, modelId });
      expect(enqueue).toHaveBeenCalledWith('bedrock', jobId);
      expect(await getItem(jobPk(jobId), JOB_SK)).toMatchObject({
        type: 'tool',
        status: 'queued',
        modelId,
        provider: 'bedrock',
        pointsReserved: points,
        request,
      });
      expect((await getItem(userPk(session.sub), usageSk('2026-10-15')))?.used).toBe(points);
      expect((await getItem(userPk(session.sub), PROFILE_SK))?.activeJobs).toBe(1);
    },
  );

  it('queues remove background, erase and outpaint on their models', async () => {
    const session = await userWithImage();
    const mask = uploadKey(session.sub, MASK_ID);
    uploads.set(mask, 20_000);
    const requests: [ToolJobRequest, string, number][] = [
      [
        { type: 'tool', imageId: IMAGE_ID, version: 1, tool: 'remove-background', params: {} },
        'stable-image-remove-background',
        7,
      ],
      [
        { type: 'tool', imageId: IMAGE_ID, version: 1, tool: 'erase', params: { maskKey: mask } },
        'stable-image-erase-object',
        7,
      ],
      [
        {
          type: 'tool',
          imageId: IMAGE_ID,
          version: 1,
          tool: 'outpaint',
          params: { left: 0, right: 512, up: 0, down: 0 },
        },
        'stable-outpaint',
        6,
      ],
    ];
    for (const [request, modelId, pointsReserved] of requests) {
      const result = await createJob(deps(), session, request);
      expect(result).toMatchObject({ status: 202, body: { modelId, pointsReserved } });
      // Two jobs at a time is the limit (LIM-3): finish this one before the next.
      await put({
        PK: userPk(session.sub),
        SK: PROFILE_SK,
        ...(await getItem(userPk(session.sub), PROFILE_SK)),
        activeJobs: 0,
      });
    }
  });

  it('runs tools on the Mock for the testers group, so end-to-end runs cost nothing', async () => {
    const session = await userWithImage({ groups: [TESTERS_GROUP] });
    const result = await createJob(deps(), session, upscale());
    expect(result).toMatchObject({ status: 202, body: { modelId: 'mock', pointsReserved: 1 } });
    expect(enqueue).toHaveBeenCalledWith('mock', expect.any(String));
  });

  it("answers 404 for another user's image, a missing version, and a mask that isn't theirs", async () => {
    const owner = await userWithImage();
    const other = await userWithImage();
    const notFound = { status: 404, body: { code: 'not_found' } };
    await expect(
      createJob(deps(), other, { ...upscale(), imageId: '01JCCCCCCCCCCCCCCCCCCCCCCC' }),
    ).resolves.toMatchObject(notFound);
    await expect(createJob(deps(), other, { ...upscale(), version: 2 })).resolves.toMatchObject(
      notFound,
    );
    const theirs = uploadKey(owner.sub, MASK_ID);
    uploads.set(theirs, 100);
    await expect(
      createJob(deps(), other, {
        type: 'tool',
        imageId: IMAGE_ID,
        version: 1,
        tool: 'erase',
        params: { maskKey: theirs },
      }),
    ).resolves.toMatchObject(notFound);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('answers 404 for a mask upload that expired or is over 10 MB', async () => {
    const session = await userWithImage();
    const missing = uploadKey(session.sub, MASK_ID);
    const huge = uploadKey(session.sub, '01JDDDDDDDDDDDDDDDDDDDDDDD');
    uploads.set(huge, 10 * 1024 * 1024 + 1);
    for (const maskKey of [missing, huge]) {
      await expect(
        createJob(deps(), session, {
          type: 'tool',
          imageId: IMAGE_ID,
          version: 1,
          tool: 'erase',
          params: { maskKey },
        }),
      ).resolves.toMatchObject({ status: 404 });
    }
  });

  it('refuses a version too small or too narrow for the tool, saying why', async () => {
    const small = await userWithImage({ width: 48, height: 48 });
    await expect(
      createJob(deps(), small, {
        type: 'tool',
        imageId: IMAGE_ID,
        version: 1,
        tool: 'remove-background',
        params: {},
      }),
    ).resolves.toMatchObject({
      status: 400,
      body: { code: 'unsupported_option', error: expect.stringMatching(/too small/) },
    });
    const narrow = await userWithImage({ width: 3000, height: 1000 });
    await expect(
      createJob(deps(), narrow, {
        type: 'tool',
        imageId: IMAGE_ID,
        version: 1,
        tool: 'outpaint',
        params: { left: 10, right: 0, up: 0, down: 0 },
      }),
    ).resolves.toMatchObject({ status: 400, body: { code: 'unsupported_option' } });
  });

  it('answers 402 when the tool costs more than the points left', async () => {
    const session = await userWithImage();
    const result = await createJob(deps({ defaultDailyPoints: 25 }), session, upscale('creative'));
    expect(result).toMatchObject({
      status: 402,
      body: { code: 'out_of_points', error: expect.stringMatching(/needs 60 points/) },
    });
  });

  it('refuses a tool whose model is switched off or has no queue', async () => {
    const session = await userWithImage();
    const off = devModels.map((model) =>
      model.id === 'stable-outpaint' ? { ...model, enabled: false } : model,
    );
    await expect(
      createJob(deps({ models: async () => off }), session, {
        type: 'tool',
        imageId: IMAGE_ID,
        version: 1,
        tool: 'outpaint',
        params: { left: 10, right: 0, up: 0, down: 0 },
      }),
    ).resolves.toMatchObject({
      status: 400,
      body: {
        code: 'model_disabled',
        error: 'Outpaint is switched off right now. Please try again later.',
      },
    });
    await expect(
      createJob(deps({ hasQueue: (provider) => provider !== 'bedrock' }), session, upscale()),
    ).resolves.toMatchObject({ status: 400, body: { code: 'model_disabled' } });
  });

  it('pauses every tool once the platform cap is reached', async () => {
    const session = await userWithImage();
    await put({ PK: PLATFORM_PK, SK: spendSk('2026-10'), spentCents: 2000 });
    try {
      const result = await createJob(deps(), session, upscale());
      expect(result).toMatchObject({
        status: 403,
        body: {
          code: 'premium_paused',
          error: expect.stringMatching(/^Image tools are paused until 1 November/),
        },
      });
    } finally {
      await put({ PK: PLATFORM_PK, SK: spendSk('2026-10'), spentCents: 0 });
    }
  });

  it('refuses parameters of another tool and an outpaint that extends nothing', async () => {
    const session = await userWithImage();
    for (const body of [
      { ...upscale(), params: { mode: 'fast', left: 10 } },
      { ...upscale(), tool: 'outpaint', params: { left: 0, right: 0, up: 0, down: 0 } },
      { ...upscale(), modelId: 'stable-fast-upscale' },
    ]) {
      await expect(createJob(deps(), session, body)).resolves.toMatchObject({
        status: 400,
        body: { code: 'invalid_request' },
      });
    }
  });
});
