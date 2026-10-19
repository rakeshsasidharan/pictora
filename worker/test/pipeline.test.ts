import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  JOB_ERROR_MESSAGES,
  JOB_SK,
  PLATFORM_PK,
  PROFILE_SK,
  imageSk,
  jobPk,
  statsModelSk,
  statsPk,
  spendSk,
  usageSk,
  userPk,
  versionSk,
  type JobImage,
  type JobItem,
} from '@pictora/core';
import {
  MockProvider,
  ProviderRateLimitError,
  createProviderFactory,
  ProviderSafetyError,
  sleep,
  type ImageProvider,
} from '@pictora/providers';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { refundJob } from '../src/job_store.js';
import {
  buildImageRequest,
  errorCode,
  imageTitle,
  processJob,
  splitPoints,
} from '../src/pipeline.js';
import { DYNAMODB_ENDPOINT, localTable } from './dynamodb_local.js';
import {
  countingMock,
  generate,
  getItem,
  model,
  newUser,
  pipelineDeps,
  pngOf,
  seedJob,
} from './helpers.js';

const s3 = mockClient(S3Client);

describe('buildImageRequest', () => {
  const signal = new AbortController().signal;

  it('sends the enhanced prompt with the style text, and the avoid text as a negative prompt', () => {
    const request = buildImageRequest(
      generate({
        prompt: 'a cat',
        enhancedPrompt: 'A ginger cat asleep on a sunny windowsill',
        avoid: ' dogs ',
        style: 'watercolour',
        aspect: '16:9',
        quality: 'high',
        count: 3,
        seed: 42,
        transparentBackground: true,
      }),
      model('mock'),
      signal,
    );
    expect(request).toEqual({
      prompt: expect.stringMatching(
        /^A ginger cat asleep on a sunny windowsill\. Style: watercolour painting/,
      ),
      negativePrompt: 'dogs',
      aspect: '16:9',
      quality: 'high',
      count: 3,
      seed: 42,
      transparentBackground: true,
      signal,
    });
  });

  it('sends the raw prompt without a style for the none preset', () => {
    expect(buildImageRequest(generate({ style: 'none' }), model('mock'), signal)).toEqual({
      prompt: 'A lighthouse at dusk',
      aspect: '1:1',
      quality: 'draft',
      count: 1,
      signal,
    });
  });

  it('drops the avoid text for a model without negative prompts', () => {
    const gemini = model('gemini-3.1-flash-image');
    expect(gemini.capabilities.negativePrompt).toBe(false);
    const request = buildImageRequest(
      generate({ modelId: gemini.id, avoid: 'text', quality: 'standard' }),
      gemini,
      signal,
    );
    expect(request).not.toHaveProperty('negativePrompt');
  });
});

describe('pipeline helpers', () => {
  it('maps provider errors to job errors', () => {
    expect(errorCode(new ProviderSafetyError('refused'))).toBe('blocked');
    expect(errorCode(new ProviderRateLimitError('busy'))).toBe('provider_error');
    expect(errorCode(new Error('boom'))).toBe('provider_error');
  });

  it('titles images from the prompt, cut at a word', () => {
    expect(imageTitle('  A lighthouse\n at dusk ')).toBe('A lighthouse at dusk');
    const long = imageTitle(`${'word '.repeat(30)}end`);
    expect(long.length).toBeLessThanOrEqual(80);
    expect(long).toMatch(/word…$/);
  });

  it('splits points evenly, the remainder to the first images', () => {
    expect(splitPoints(9, 3)).toEqual([3, 3, 3]);
    expect(splitPoints(7, 3)).toEqual([3, 2, 2]);
    expect(splitPoints(0, 2)).toEqual([0, 0]);
  });
});

describe.skipIf(!DYNAMODB_ENDPOINT)('processJob', () => {
  let table: ReturnType<typeof localTable>;

  beforeEach(async () => {
    table = localTable('pictora-worker');
    await table.create();
    s3.reset();
    s3.on(PutObjectCommand).resolves({});
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await table.drop();
  });

  const item = (pk: string, sk: string) => getItem(table.client, table.tableName, pk, sk);
  const jobOf = (jobId: string) => item(jobPk(jobId), JOB_SK);
  const usedOn = async (sub: string, date = '2026-10-15') =>
    (await item(userPk(sub), usageSk(date)))?.used;
  const activeJobs = async (sub: string) => (await item(userPk(sub), PROFILE_SK))?.activeJobs;
  const stats = (modelId = 'mock', date = '2026-10-15') =>
    item(statsPk(date), statsModelSk(modelId));
  const spend = () => item(PLATFORM_PK, spendSk('2026-10'));
  const deps = (adapter: ImageProvider, overrides = {}) =>
    pipelineDeps(table.client, table.tableName, adapter, overrides);

  it('takes a mock job from queued to succeeded, storing the images and settling the points', async () => {
    const sub = newUser();
    const request = generate({ quality: 'high', count: 2, seed: 7 });
    const job = await seedJob(table.client, table.tableName, sub, {
      request,
      pointsReserved: 6,
      usedBefore: 4,
    });
    const { provider, calls } = countingMock();

    expect(await processJob(deps(provider), job.jobId)).toBe('succeeded');
    expect(calls()).toBe(1);

    const done = await jobOf(job.jobId);
    expect(done).toMatchObject({
      status: 'succeeded',
      attempts: 1,
      startedAt: '2026-10-15T12:00:30.000Z',
      finishedAt: '2026-10-15T12:00:30.000Z',
      pointsCharged: 6,
      providerCostCents: 6,
    });
    expect(done).not.toHaveProperty('GSI1PK');
    expect(done).not.toHaveProperty('GSI1SK');
    const images = done?.images as JobImage[];
    expect(images).toHaveLength(2);

    const puts = s3.commandCalls(PutObjectCommand).map((call) => call.args[0].input);
    expect(puts).toHaveLength(4);
    for (const image of images) {
      expect(image).toEqual({
        imageId: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/),
        version: 1,
        s3Key: `users/${sub}/${image.imageId}/v1.png`,
      });
      const png = puts.find((put) => put.Key === image.s3Key);
      expect(png).toMatchObject({ Bucket: 'pictora-test-images', ContentType: 'image/png' });
      expect(
        Buffer.from(png?.Body as Uint8Array)
          .subarray(1, 4)
          .toString(),
      ).toBe('PNG');
      const thumb = puts.find((put) => put.Key === `users/${sub}/${image.imageId}/v1_thumb.webp`);
      expect(thumb).toMatchObject({ ContentType: 'image/webp' });

      expect(await item(userPk(sub), imageSk(image.imageId))).toMatchObject({
        imageId: image.imageId,
        title: 'A lighthouse at dusk',
        latestVersion: 1,
        versionCount: 1,
        style: 'photorealistic',
        modelId: 'mock',
        createdAt: '2026-10-15T12:00:30.000Z',
        thumbKey: `users/${sub}/${image.imageId}/v1_thumb.webp`,
      });
      expect(await item(userPk(sub), versionSk(image.imageId, 1))).toMatchObject({
        version: 1,
        s3Key: image.s3Key,
        width: 1024,
        height: 1024,
        prompt: 'A lighthouse at dusk',
        sentPrompt: expect.stringMatching(/^A lighthouse at dusk\. Style: photorealistic/),
        modelId: 'mock',
        quality: 'high',
        aspect: '1:1',
        seed: expect.any(Number),
        jobId: job.jobId,
        costPoints: 3,
      });
    }

    expect(await usedOn(sub)).toBe(10);
    expect(await item(userPk(sub), usageSk('2026-10-15'))).toMatchObject({
      GSI1PK: 'USAGE#2026-10-15',
      GSI1SK: '0000000010',
    });
    expect(await activeJobs(sub)).toBe(0);
    expect(await spend()).toMatchObject({ spentCents: 6 });
    expect(await stats()).toMatchObject({ images: 2, points: 6, providerCostCents: 6 });
  });

  it('adds every job to the month spend and the day stats', async () => {
    const { provider } = countingMock();
    for (const quality of ['draft', 'standard', 'high'] as const) {
      const job = await seedJob(table.client, table.tableName, newUser(), {
        request: generate({ quality }),
        pointsReserved: { draft: 1, standard: 2, high: 3 }[quality],
      });
      expect(await processJob(deps(provider), job.jobId)).toBe('succeeded');
    }
    const failing = await seedJob(table.client, table.tableName, newUser(), {
      request: generate({ prompt: 'a lighthouse __fail__' }),
    });
    expect(await processJob(deps(provider), failing.jobId)).toBe('failed');

    expect(await spend()).toMatchObject({ spentCents: 6 });
    const day = await stats();
    expect(day).toMatchObject({ images: 3, points: 6, providerCostCents: 6, failures: 1 });
    expect(day?.ttl).toBe(Math.floor(Date.parse('2026-10-15T12:00:30Z') / 1000) + 400 * 86_400);
  });

  it('publishes the month spend after each job with a provider cost, and records the cap', async () => {
    const { provider } = countingMock();
    const spendDeps = deps(provider, { spend: { capCents: 2000, namespace: 'Pictora/dev' } });
    const metric = () =>
      vi
        .mocked(console.log)
        .mock.calls.map(([line]) => String(line))
        .filter((line) => line.includes('"_aws"'))
        .map((line) => JSON.parse(line));

    const job = await seedJob(table.client, table.tableName, newUser(), {
      request: generate({ quality: 'high' }),
      pointsReserved: 3,
    });
    expect(await processJob(spendDeps, job.jobId)).toBe('succeeded');
    expect(await spend()).toMatchObject({ spentCents: 3, capCents: 2000 });
    expect(metric()).toEqual([
      {
        _aws: {
          Timestamp: Date.parse('2026-10-15T12:00:30.000Z'),
          CloudWatchMetrics: [
            {
              Namespace: 'Pictora/dev',
              Dimensions: [[]],
              Metrics: [{ Name: 'MonthlySpendCents', Unit: 'Count' }],
            },
          ],
        },
        MonthlySpendCents: 3,
      },
    ]);

    // A failure the provider still billed for counts too; one with no cost publishes nothing.
    const storing = await seedJob(table.client, table.tableName, newUser(), {
      request: generate({ quality: 'standard' }),
      pointsReserved: 2,
    });
    s3.on(PutObjectCommand).rejects(new Error('S3 down'));
    expect(await processJob(spendDeps, storing.jobId)).toBe('failed');
    expect(metric().map((line) => line.MonthlySpendCents)).toEqual([3, 5]);
    const failing = await seedJob(table.client, table.tableName, newUser(), {
      request: generate({ prompt: 'a lighthouse __fail__' }),
    });
    expect(await processJob(spendDeps, failing.jobId)).toBe('failed');
    expect(metric()).toHaveLength(2);
  });

  it('publishes no spend metric without spend reporting configured', async () => {
    const { provider } = countingMock();
    const job = await seedJob(table.client, table.tableName, newUser(), {
      request: generate(),
    });
    expect(await processJob(deps(provider), job.jobId)).toBe('succeeded');
    const lines = vi.mocked(console.log).mock.calls.map(([line]) => String(line));
    expect(lines.some((line) => line.includes('MonthlySpendCents'))).toBe(false);
    expect((await spend())?.capCents).toBeUndefined();
  });

  it.each([
    ['__fail__', 'failed', 'provider_error'],
    ['__block__', 'blocked', 'blocked'],
    ['__timeout__', 'failed', 'timeout'],
  ] as const)('refunds a %s job in full and marks it %s', async (keyword, status, code) => {
    const sub = newUser();
    const job = await seedJob(table.client, table.tableName, sub, {
      request: generate({ prompt: `a lighthouse ${keyword}`, quality: 'standard', count: 2 }),
      pointsReserved: 4,
      usedBefore: 3,
    });
    expect(await processJob(deps(new MockProvider({ delayMs: 0 })), job.jobId)).toBe(status);

    const done = await jobOf(job.jobId);
    expect(done).toMatchObject({
      status,
      error: { code, message: JOB_ERROR_MESSAGES[code] },
      pointsCharged: 0,
      finishedAt: '2026-10-15T12:00:30.000Z',
    });
    expect(done).not.toHaveProperty('images');
    expect(done).not.toHaveProperty('GSI1PK');
    expect(await usedOn(sub)).toBe(3);
    expect(await activeJobs(sub)).toBe(0);
    expect(s3.commandCalls(PutObjectCommand)).toHaveLength(0);
    expect(await stats()).toMatchObject(status === 'blocked' ? { blocks: 1 } : { failures: 1 });
    expect(await spend()).toBeUndefined();
  });

  it('fails with a refund when the provider runs past its deadline', async () => {
    const sub = newUser();
    const job = await seedJob(table.client, table.tableName, sub);
    const hanging: ImageProvider = {
      generate: async (_model, req) => {
        await sleep(10_000, req.signal);
        throw new Error('unreachable');
      },
      edit: () => Promise.reject(new Error('unused')),
    };
    expect(await processJob(deps(hanging, { providerTimeoutMs: 50 }), job.jobId)).toBe('failed');
    expect(await jobOf(job.jobId)).toMatchObject({ error: { code: 'timeout' } });
    expect(await usedOn(sub)).toBe(0);
    expect(await activeJobs(sub)).toBe(0);
  });

  it('retries a rate-limited call once, then fails with a refund', async () => {
    const sub = newUser();
    const job = await seedJob(table.client, table.tableName, sub);
    const generateCall = vi.fn(async () => {
      throw new ProviderRateLimitError('429');
    });
    const busy: ImageProvider = { generate: generateCall, edit: generateCall };
    expect(await processJob(deps(busy), job.jobId)).toBe('failed');
    expect(generateCall).toHaveBeenCalledTimes(2);
    expect(await jobOf(job.jobId)).toMatchObject({ error: { code: 'provider_error' } });
    expect(await usedOn(sub)).toBe(0);
  });

  it('charges only for the images returned on a partial success', async () => {
    const sub = newUser();
    const job = await seedJob(table.client, table.tableName, sub, {
      request: generate({ quality: 'high', count: 4 }),
      pointsReserved: 12,
    });
    const png = await pngOf(1024, 1024);
    const partial: ImageProvider = {
      generate: async () => ({
        images: [
          { png, width: 1024, height: 1024, seed: 1 },
          { png, width: 1024, height: 1024, seed: 2 },
          { png, width: 1024, height: 1024, seed: 3 },
        ],
        providerCostCents: 9,
      }),
      edit: () => Promise.reject(new Error('unused')),
    };
    expect(await processJob(deps(partial), job.jobId)).toBe('succeeded');
    const done = await jobOf(job.jobId);
    expect(done).toMatchObject({ pointsCharged: 9, providerCostCents: 9 });
    expect(done?.images).toHaveLength(3);
    expect(await usedOn(sub)).toBe(9);
    expect(await stats()).toMatchObject({ images: 3, points: 9 });
  });

  it('caps a partial charge at the returned images even when the provider bills for all of them', async () => {
    const sub = newUser();
    const job = await seedJob(table.client, table.tableName, sub, {
      request: generate({ quality: 'standard', count: 4 }),
      pointsReserved: 8,
    });
    const png = await pngOf(1024, 1024);
    const partial: ImageProvider = {
      generate: async () => ({
        images: [{ png, width: 1024, height: 1024 }],
        providerCostCents: 8,
      }),
      edit: () => Promise.reject(new Error('unused')),
    };
    expect(await processJob(deps(partial), job.jobId)).toBe('succeeded');
    expect(await jobOf(job.jobId)).toMatchObject({ pointsCharged: 2, providerCostCents: 8 });
    expect(await usedOn(sub)).toBe(2);
    // The platform still pays what the provider billed.
    expect(await spend()).toMatchObject({ spentCents: 8 });
  });

  it('settles a cheaper-than-estimated job down to the actual cost, rounded up', async () => {
    const sub = newUser();
    const job = await seedJob(table.client, table.tableName, sub, {
      request: generate({ quality: 'high', count: 2 }),
      pointsReserved: 6,
      usedBefore: 1,
    });
    const png = await pngOf(512, 512);
    const cheap: ImageProvider = {
      generate: async () => ({
        images: [
          { png, width: 512, height: 512 },
          { png, width: 512, height: 512 },
        ],
        providerCostCents: 3.2,
      }),
      edit: () => Promise.reject(new Error('unused')),
    };
    expect(await processJob(deps(cheap), job.jobId)).toBe('succeeded');
    expect(await jobOf(job.jobId)).toMatchObject({ pointsCharged: 4, providerCostCents: 3.2 });
    expect(await usedOn(sub)).toBe(5);
  });

  it('fails with a refund when the provider returns no images, counting what it cost', async () => {
    const sub = newUser();
    const job = await seedJob(table.client, table.tableName, sub);
    const empty: ImageProvider = {
      generate: async () => ({ images: [], providerCostCents: 2 }),
      edit: () => Promise.reject(new Error('unused')),
    };
    expect(await processJob(deps(empty), job.jobId)).toBe('failed');
    expect(await jobOf(job.jobId)).toMatchObject({ status: 'failed', providerCostCents: 2 });
    expect(await usedOn(sub)).toBe(0);
    expect(await spend()).toMatchObject({ spentCents: 2 });
  });

  it('never calls the provider twice for a redelivered message', async () => {
    const sub = newUser();
    const job = await seedJob(table.client, table.tableName, sub, {
      request: generate({ quality: 'standard' }),
      pointsReserved: 2,
    });
    const { provider, calls } = countingMock();
    expect(await processJob(deps(provider), job.jobId)).toBe('succeeded');
    expect(await processJob(deps(provider), job.jobId)).toBe('skipped');
    expect(calls()).toBe(1);
    expect(await usedOn(sub)).toBe(2);
    expect(await activeJobs(sub)).toBe(0);
    expect(await stats()).toMatchObject({ images: 1 });
  });

  it('runs a job once when two deliveries of its message arrive together', async () => {
    const sub = newUser();
    const job = await seedJob(table.client, table.tableName, sub);
    const { provider, calls } = countingMock();
    const outcomes = await Promise.all([
      processJob(deps(provider), job.jobId),
      processJob(deps(provider), job.jobId),
      processJob(deps(provider), job.jobId),
    ]);
    expect(outcomes.sort()).toEqual(['skipped', 'skipped', 'succeeded']);
    expect(calls()).toBe(1);
    expect(await activeJobs(sub)).toBe(0);
  });

  it('leaves a running or finished job alone', async () => {
    const { provider, calls } = countingMock();
    for (const status of ['running', 'failed'] as const) {
      const sub = newUser();
      const job = await seedJob(table.client, table.tableName, sub, {
        status,
        startedAt: '2026-10-15T12:00:10.000Z',
      });
      expect(await processJob(deps(provider), job.jobId)).toBe('skipped');
      expect((await jobOf(job.jobId))?.status).toBe(status);
      expect(await activeJobs(sub)).toBe(1);
    }
    expect(await processJob(deps(provider), '01JNOSUCHJOB0000000000000A')).toBe('skipped');
    expect(calls()).toBe(0);
  });

  it('settles and refunds against the day the points were reserved, after midnight', async () => {
    const sub = newUser();
    const job = await seedJob(table.client, table.tableName, sub, {
      request: generate({ prompt: 'late __fail__' }),
      usageDate: '2026-10-14',
      createdAt: '2026-10-14T23:59:58.000Z',
    });
    const d = deps(new MockProvider({ delayMs: 0 }), {
      now: () => new Date('2026-10-15T00:00:03.000Z'),
    });
    expect(await processJob(d, job.jobId)).toBe('failed');
    expect(await usedOn(sub, '2026-10-14')).toBe(0);
    expect(await usedOn(sub, '2026-10-15')).toBeUndefined();
  });

  it('blocks a request the moderation hook flags, without calling the provider', async () => {
    const sub = newUser();
    const job = await seedJob(table.client, table.tableName, sub, {
      request: generate({ enhancedPrompt: 'A lighthouse at dusk, storm clouds' }),
    });
    const { provider, calls } = countingMock();
    const moderate = vi.fn(async () => ({ flagged: true as const, category: 'violence' }));
    expect(await processJob(deps(provider, { moderate }), job.jobId)).toBe('blocked');
    expect(moderate).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          prompt: expect.stringMatching(/^A lighthouse at dusk, storm clouds\. Style:/),
        }),
      }),
    );
    expect(calls()).toBe(0);
    expect(await jobOf(job.jobId)).toMatchObject({ status: 'blocked', error: { code: 'blocked' } });
    expect(await usedOn(sub)).toBe(0);
  });

  it('fails safe when the moderation hook throws', async () => {
    const sub = newUser();
    const job = await seedJob(table.client, table.tableName, sub);
    const { provider, calls } = countingMock();
    const moderate = vi.fn(async () => {
      throw new Error('moderation down');
    });
    expect(await processJob(deps(provider, { moderate }), job.jobId)).toBe('failed');
    expect(calls()).toBe(0);
    expect(await usedOn(sub)).toBe(0);
  });

  it('passes a request the moderation hook clears to the provider', async () => {
    const job = await seedJob(table.client, table.tableName, newUser());
    const { provider, calls } = countingMock();
    const moderate = vi.fn(async () => ({ flagged: false as const }));
    expect(await processJob(deps(provider, { moderate }), job.jobId)).toBe('succeeded');
    expect(calls()).toBe(1);
  });

  it('fails with a refund, without a provider call, when the model was switched off', async () => {
    const sub = newUser();
    const job = await seedJob(table.client, table.tableName, sub);
    const { provider, calls } = countingMock();
    const models = async () => [{ ...model('mock'), enabled: false }];
    expect(await processJob(deps(provider, { models }), job.jobId)).toBe('failed');
    expect(calls()).toBe(0);
    expect(await jobOf(job.jobId)).toMatchObject({ error: { code: 'provider_error' } });
    expect(await usedOn(sub)).toBe(0);
  });

  it('routes by the job provider: a model without an adapter fails with a refund', async () => {
    const sub = newUser();
    const job = await seedJob(table.client, table.tableName, sub, {
      request: generate({ modelId: 'gpt-image-2', quality: 'draft' }),
      provider: 'openai',
    });
    const mockOnly = createProviderFactory({ adapters: { mock: () => new MockProvider() } });
    const noOpenAi = deps(new MockProvider({ delayMs: 0 }), { provider: mockOnly });
    expect(await processJob(noOpenAi, job.jobId)).toBe('failed');
    expect(await usedOn(sub)).toBe(0);
  });

  it('fails with a refund, counting the spend, when storing an image fails', async () => {
    const sub = newUser();
    const job = await seedJob(table.client, table.tableName, sub, {
      request: generate({ quality: 'standard' }),
      pointsReserved: 2,
    });
    s3.on(PutObjectCommand).rejects(new Error('S3 unavailable'));
    expect(await processJob(deps(new MockProvider({ delayMs: 0 })), job.jobId)).toBe('failed');
    expect(await jobOf(job.jobId)).toMatchObject({
      status: 'failed',
      error: { code: 'provider_error' },
      providerCostCents: 2,
    });
    expect(await usedOn(sub)).toBe(0);
    expect(await activeJobs(sub)).toBe(0);
    expect(await spend()).toMatchObject({ spentCents: 2 });
    expect(await stats()).toMatchObject({ failures: 1, providerCostCents: 2 });
  });

  it('records nothing when the sweeper failed the job while the provider was working', async () => {
    const sub = newUser();
    const job = await seedJob(table.client, table.tableName, sub);
    const mock = new MockProvider({ delayMs: 0 });
    const sweptMidCall: ImageProvider = {
      generate: async (m, req) => {
        const running = await jobOf(job.jobId);
        await refundJob(table, {
          job: running as unknown as JobItem,
          from: 'running',
          status: 'failed',
          error: { code: 'stuck', message: JOB_ERROR_MESSAGES.stuck },
          now: new Date('2026-10-15T12:06:00Z'),
        });
        return mock.generate(m, req);
      },
      edit: () => Promise.reject(new Error('unused')),
    };
    expect(await processJob(deps(sweptMidCall), job.jobId)).toBe('skipped');
    expect(await jobOf(job.jobId)).toMatchObject({ status: 'failed', error: { code: 'stuck' } });
    // Refunded once, by the sweeper, and the slot freed once.
    expect(await usedOn(sub)).toBe(0);
    expect(await activeJobs(sub)).toBe(0);
    expect(await stats()).not.toHaveProperty('images');
  });
});
