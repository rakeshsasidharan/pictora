import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  JOB_SK,
  PROFILE_SK,
  blockSk,
  jobPk,
  modlogPk,
  usageSk,
  userPk,
  type ModerationResult,
} from '@pictora/core';
import { OPENAI_MODERATION_URL, createModerator, type Moderate } from '@pictora/providers';
import { mockClient } from 'aws-sdk-client-mock';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { moderateImageRequests } from '../src/moderation.js';
import { processJob } from '../src/pipeline.js';
import { DYNAMODB_ENDPOINT, localTable } from './dynamodb_local.js';
import {
  countingMock,
  generate,
  getItem,
  model,
  newUser,
  pipelineDeps,
  seedJob,
} from './helpers.js';

const s3 = mockClient(S3Client);
const NOW = new Date('2026-10-15T12:00:30.000Z');

function verdict(...flagged: string[]): ModerationResult {
  return {
    flagged: flagged.length > 0,
    categories: Object.fromEntries(flagged.map((category) => [category, true])),
  };
}

const imageRequest = (overrides = {}) => ({
  prompt: 'A lighthouse at dusk',
  aspect: '1:1' as const,
  quality: 'draft' as const,
  count: 1,
  signal: new AbortController().signal,
  ...overrides,
});

describe('moderateImageRequests', () => {
  const job = {} as never;

  it('checks the prompt, then each input image, and blocks under the policy', async () => {
    const parent = new Uint8Array([1]);
    const reference = new Uint8Array([2]);
    const moderate = vi.fn<Moderate>(async (input) =>
      input.image === reference ? verdict('self-harm') : verdict(),
    );
    const hook = moderateImageRequests(moderate);
    expect(
      await hook({
        job,
        model: model('mock'),
        request: imageRequest({ inputImage: parent, referenceImages: [reference] }),
      }),
    ).toEqual({ flagged: true, category: 'self-harm', stage: 'image' });
    expect(moderate.mock.calls.map(([input]) => input)).toEqual([
      { text: 'A lighthouse at dusk' },
      { image: parent },
      { image: reference },
    ]);
  });

  it('blocks a flagged prompt without checking images', async () => {
    const moderate = vi.fn<Moderate>(async () => verdict('sexual', 'violence'));
    expect(
      await moderateImageRequests(moderate)({
        job,
        model: model('mock'),
        request: imageRequest({ inputImage: new Uint8Array([1]) }),
      }),
    ).toEqual({ flagged: true, category: 'sexual', stage: 'prompt' });
    expect(moderate).toHaveBeenCalledTimes(1);
  });

  it('lets through a flag on a category the policy allows', async () => {
    const moderate = vi.fn<Moderate>(async () => verdict('violence'));
    expect(
      await moderateImageRequests(moderate)({ job, model: model('mock'), request: imageRequest() }),
    ).toEqual({ flagged: false });
  });

  it('throws when the endpoint fails', async () => {
    const moderate = vi.fn<Moderate>(async () => {
      throw new Error('down');
    });
    await expect(
      moderateImageRequests(moderate)({ job, model: model('mock'), request: imageRequest() }),
    ).rejects.toThrow('down');
  });
});

describe.skipIf(!DYNAMODB_ENDPOINT)('blocks', () => {
  // DynamoDB Local is reached over HTTP too, so only the moderation endpoint is intercepted.
  const server = setupServer();
  beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }));
  afterAll(() => server.close());

  let table: ReturnType<typeof localTable>;

  beforeEach(async () => {
    table = localTable('pictora-moderation');
    await table.create();
    s3.reset();
    s3.on(PutObjectCommand).resolves({});
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    server.resetHandlers();
    vi.restoreAllMocks();
    await table.drop();
  });

  const item = (pk: string, sk: string) => getItem(table.client, table.tableName, pk, sk);
  const profile = (sub: string) => item(userPk(sub), PROFILE_SK);
  const usedOn = async (sub: string) => (await item(userPk(sub), usageSk('2026-10-15')))?.used;
  const query = async (pk: string, prefix?: string) =>
    (
      await table.client.send(
        new QueryCommand({
          TableName: table.tableName,
          KeyConditionExpression: prefix ? 'PK = :pk AND begins_with(SK, :prefix)' : 'PK = :pk',
          ExpressionAttributeValues: { ':pk': pk, ...(prefix ? { ':prefix': prefix } : {}) },
        }),
      )
    ).Items ?? [];
  const blocksOf = (sub: string) => query(userPk(sub), 'BLOCK#');
  const modlog = () => query(modlogPk('2026-10-15'));

  /** The deployed hook, talking to the moderation endpoint that msw stands in for. */
  const realModeration = () =>
    moderateImageRequests(
      createModerator({ apiKey: async () => 'sk-test', retry: { delayMs: 0, jitterMs: 0 } }),
    );
  const endpointSays = (body: Record<string, unknown>, status = 200) =>
    server.use(http.post(OPENAI_MODERATION_URL, () => HttpResponse.json(body, { status })));

  it('blocks a flagged prompt with a refund, a BLOCK# item and a MODLOG# entry', async () => {
    endpointSays({ results: [{ flagged: true, categories: { sexual: true } }] });
    const sub = newUser();
    const job = await seedJob(table.client, table.tableName, sub, {
      request: generate({ prompt: 'something explicit', count: 2 }),
    });
    const { provider, calls } = countingMock();
    const deps = pipelineDeps(table.client, table.tableName, provider, {
      moderate: realModeration(),
    });

    expect(await processJob(deps, job.jobId)).toBe('blocked');
    expect(calls()).toBe(0);
    const done = await item(jobPk(job.jobId), JOB_SK);
    expect(done).toMatchObject({ status: 'blocked', pointsCharged: 0, error: { code: 'blocked' } });
    // The user sees the neutral message, never the category.
    expect(JSON.stringify(done?.error)).not.toContain('sexual');
    expect(await usedOn(sub)).toBe(0);

    const blocks = await blocksOf(sub);
    expect(blocks).toEqual([
      {
        PK: userPk(sub),
        SK: expect.stringMatching(/^BLOCK#[0-9A-HJKMNP-TV-Z]{26}$/),
        stage: 'prompt',
        category: 'sexual',
        jobId: job.jobId,
        createdAt: NOW.toISOString(),
        ttl: Math.floor(NOW.getTime() / 1000) + 86_400,
      },
    ]);
    expect(await modlog()).toEqual([
      {
        PK: 'MODLOG#2026-10-15',
        SK: (blocks[0]?.SK as string).slice('BLOCK#'.length),
        type: 'block',
        userId: sub,
        stage: 'prompt',
        category: 'sexual',
        promptExcerpt: expect.stringMatching(/^something explicit\. Style: photorealistic/),
        provider: 'mock',
        modelId: 'mock',
        jobId: job.jobId,
        createdAt: NOW.toISOString(),
        ttl: Math.floor(NOW.getTime() / 1000) + 90 * 86_400,
      },
    ]);
    expect((await profile(sub))?.cooldownUntil).toBeUndefined();
  });

  it('records a provider refusal (the mock __block__ trigger) as a provider-stage block', async () => {
    endpointSays({ results: [{ flagged: false, categories: {} }] });
    const sub = newUser();
    const job = await seedJob(table.client, table.tableName, sub, {
      request: generate({ prompt: 'a lighthouse __block__' }),
    });
    const { provider, calls } = countingMock();
    const deps = pipelineDeps(table.client, table.tableName, provider, {
      moderate: realModeration(),
    });
    expect(await processJob(deps, job.jobId)).toBe('blocked');
    expect(calls()).toBe(1);
    expect(await usedOn(sub)).toBe(0);
    expect(await blocksOf(sub)).toMatchObject([
      { stage: 'provider', category: 'provider_refusal' },
    ]);
    expect(await modlog()).toMatchObject([
      { type: 'block', stage: 'provider', category: 'provider_refusal', userId: sub },
    ]);
  });

  it('lets a request through when only allowed categories are flagged', async () => {
    endpointSays({ results: [{ flagged: true, categories: { violence: true } }] });
    const job = await seedJob(table.client, table.tableName, newUser(), {
      request: generate({ prompt: 'a knight fighting a dragon' }),
    });
    const { provider } = countingMock();
    const deps = pipelineDeps(table.client, table.tableName, provider, {
      moderate: realModeration(),
    });
    expect(await processJob(deps, job.jobId)).toBe('succeeded');
    expect(await modlog()).toEqual([]);
  });

  it('fails with a refund, never calling the provider, when moderation is down', async () => {
    endpointSays({ error: { message: 'server error' } }, 500);
    const sub = newUser();
    const job = await seedJob(table.client, table.tableName, sub);
    const { provider, calls } = countingMock();
    const deps = pipelineDeps(table.client, table.tableName, provider, {
      moderate: realModeration(),
    });
    expect(await processJob(deps, job.jobId)).toBe('failed');
    expect(calls()).toBe(0);
    expect(await item(jobPk(job.jobId), JOB_SK)).toMatchObject({
      status: 'failed',
      error: { code: 'provider_error' },
    });
    expect(await usedOn(sub)).toBe(0);
    expect(await blocksOf(sub)).toEqual([]);
  });

  it('cools the account down for 24 h at the third block in 24 h', async () => {
    const sub = newUser();
    // A block from 25 hours ago no longer counts, even before DynamoDB expires it.
    await table.client.send(
      new PutCommand({
        TableName: table.tableName,
        Item: {
          PK: userPk(sub),
          SK: blockSk('01J00000000000000000000000'),
          stage: 'prompt',
          category: 'hate',
          createdAt: new Date(NOW.getTime() - 25 * 3_600_000).toISOString(),
        },
      }),
    );
    const moderate = vi.fn(async () => ({ flagged: true as const, category: 'hate' }));
    const { provider } = countingMock();
    const deps = pipelineDeps(table.client, table.tableName, provider, { moderate });

    for (let block = 1; block <= 3; block++) {
      const job = await seedJob(table.client, table.tableName, sub);
      expect(await processJob(deps, job.jobId)).toBe('blocked');
      const cooldown = (await profile(sub))?.cooldownUntil;
      expect(cooldown).toBe(block < 3 ? undefined : '2026-10-16T12:00:30.000Z');
    }
    expect(await blocksOf(sub)).toHaveLength(4);
  });

  it('never shortens a longer cooldown', async () => {
    const sub = newUser();
    const moderate = vi.fn(async () => ({ flagged: true as const, category: 'hate' }));
    const { provider } = countingMock();
    const deps = pipelineDeps(table.client, table.tableName, provider, { moderate });
    for (let block = 1; block <= 3; block++) {
      const job = await seedJob(table.client, table.tableName, sub);
      if (block === 3) {
        // seedJob rewrites the profile, so the longer cooldown goes on after it.
        await table.client.send(
          new PutCommand({
            TableName: table.tableName,
            Item: {
              PK: userPk(sub),
              SK: PROFILE_SK,
              status: 'active',
              activeJobs: 1,
              cooldownUntil: '2026-10-20T00:00:00.000Z',
            },
          }),
        );
      }
      await processJob(deps, job.jobId);
    }
    expect((await profile(sub))?.cooldownUntil).toBe('2026-10-20T00:00:00.000Z');
  });
});
