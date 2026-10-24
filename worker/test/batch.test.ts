import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DeleteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  JOB_ERROR_MESSAGES,
  JOB_SK,
  PROFILE_SK,
  blockSk,
  imageSk,
  jobPk,
  statsModelSk,
  statsPk,
  usageSk,
  userPk,
  type JobItem,
} from '@pictora/core';
import type { EmitMetrics } from '@pictora/core/observability';
import {
  GeminiProvider,
  MockProvider,
  OpenAiProvider,
  ProviderError,
  ProviderSafetyError,
  createBatchProviderFactory,
  type BatchImageProvider,
  type BatchItem,
  type BatchPoll,
} from '@pictora/providers';
import { mockClient } from 'aws-sdk-client-mock';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { ulid } from 'ulid';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BATCH_GRACE_MS,
  UNRECORDED_BATCH_MS,
  pollBatches,
  submitBatches,
  type BatchDeps,
} from '../src/batch.js';
import type { ModerateRequest } from '../src/pipeline.js';
import { DYNAMODB_ENDPOINT, localTable } from './dynamodb_local.js';
import { devModels, generate, getItem, newUser, pngOf, seedJob } from './helpers.js';

const s3 = mockClient(S3Client);
const OPENAI_URL = 'https://openai.test/v1';
const GEMINI_URL = 'https://gemini.test';
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'bypass' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const NOW = new Date('2026-10-15T12:30:00.000Z');
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const HOUR = 60;
const DAY = 24 * HOUR;

/** A batch adapter whose answers a test sets, recording what it was sent. */
function stubBatches() {
  const submitted: { modelId: string; items: BatchItem[] }[] = [];
  const polled: string[] = [];
  const stub = {
    submit: async (): Promise<string> => `batch-${submitted.length}`,
    poll: async (): Promise<BatchPoll> => ({ state: 'pending' }),
  };
  const provider: BatchImageProvider = {
    submitBatch: async (model, items) => {
      submitted.push({ modelId: model.id, items: [...items] });
      return stub.submit();
    },
    pollBatch: async (_model, batchId) => {
      polled.push(batchId);
      return stub.poll();
    },
  };
  return { provider, stub, submitted, polled };
}

describe.skipIf(!DYNAMODB_ENDPOINT)('batch jobs', () => {
  let table: ReturnType<typeof localTable>;

  beforeEach(async () => {
    table = localTable('pictora-batch');
    await table.create();
    s3.reset();
    s3.on(PutObjectCommand).resolves({});
    s3.on(DeleteObjectCommand).resolves({});
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await table.drop();
  });

  function deps(batchProvider: BatchImageProvider, overrides: Partial<BatchDeps> = {}): BatchDeps {
    return {
      ...table,
      s3: new S3Client({
        region: 'us-west-2',
        credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      }),
      bucket: 'pictora-test-images',
      models: async () => devModels,
      batchProvider: () => batchProvider,
      now: () => NOW,
      newImageId: () => ulid(),
      ...overrides,
    };
  }

  const item = (pk: string, sk: string) => getItem(table.client, table.tableName, pk, sk);
  const jobOf = async (jobId: string) => (await item(jobPk(jobId), JOB_SK)) as JobItem | undefined;
  const usedOn = async (sub: string) => (await item(userPk(sub), usageSk('2026-10-15')))?.used;
  const activeJobs = async (sub: string) => (await item(userPk(sub), PROFILE_SK))?.activeJobs;

  /** A batch job as the job API leaves it: scheduled, half the points reserved. */
  function scheduled(sub: string, options: Parameters<typeof seedJob>[3] = {}) {
    const request = options.request ?? generate({ delivery: 'batch' });
    return seedJob(table.client, table.tableName, sub, {
      status: 'scheduled',
      createdAt: minutesAgo(20),
      ...options,
      request,
    });
  }

  /** A batch job the submitter put in `batchId`. */
  function submitted(sub: string, batchId: string, options: Parameters<typeof seedJob>[3] = {}) {
    return scheduled(sub, {
      status: 'submitted',
      submittedAt: minutesAgo(15),
      batchId,
      ...options,
    });
  }

  describe('submitter', () => {
    it('sends scheduled jobs as one provider batch per model, through the OpenAI and Gemini batch APIs', async () => {
      const uploads: string[] = [];
      server.use(
        http.post(`${OPENAI_URL}/files`, async ({ request }) => {
          uploads.push(await ((await request.formData()).get('file') as File).text());
          return HttpResponse.json({ id: 'file-in', object: 'file', purpose: 'batch' });
        }),
        http.post(`${OPENAI_URL}/batches`, () =>
          HttpResponse.json({ id: 'batch_openai', status: 'validating' }),
        ),
        http.post(
          /^https:\/\/gemini\.test\/v1beta\/models\/[^/]+:batchGenerateContent$/,
          async ({ request }) => {
            const body = (await request.json()) as {
              batch: { inputConfig: { requests: { requests: { metadata: { key: string } }[] } } };
            };
            uploads.push(
              body.batch.inputConfig.requests.requests
                .map((request) => request.metadata.key)
                .join(','),
            );
            return HttpResponse.json({
              name: 'batches/gemini-1',
              metadata: { state: 'BATCH_STATE_PENDING' },
            });
          },
        ),
      );
      const factory = createBatchProviderFactory({
        openai: () => new OpenAiProvider({ apiKey: async () => 'sk', baseURL: OPENAI_URL }),
        gemini: () =>
          new GeminiProvider({
            config: { backend: 'api' },
            credential: async () => 'g-key',
            baseUrl: GEMINI_URL,
          }),
      });
      const sub = newUser();
      const a = await scheduled(sub, {
        request: generate({ delivery: 'batch', modelId: 'gpt-image-2' }),
        provider: 'openai',
        createdAt: minutesAgo(30),
      });
      const b = await scheduled(newUser(), {
        request: generate({ delivery: 'batch', modelId: 'gpt-image-2', count: 2 }),
        provider: 'openai',
        createdAt: minutesAgo(25),
      });
      const c = await scheduled(newUser(), {
        request: generate({
          delivery: 'batch',
          modelId: 'gemini-3.1-flash-image',
          quality: 'standard',
          count: 2,
        }),
        provider: 'gemini',
      });

      const result = await submitBatches({
        ...deps(stubBatches().provider),
        batchProvider: factory,
      });

      expect(result).toMatchObject({
        done: [a.jobId, b.jobId, c.jobId],
        refunded: [],
        errors: [],
        batches: ['batch_openai', 'batches/gemini-1'],
      });
      const openAiLines = uploads[0]!
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { custom_id: string; body: { n: number } });
      expect(openAiLines.map((line) => [line.custom_id, line.body.n])).toEqual([
        [a.jobId, 1],
        [b.jobId, 2],
      ]);
      expect(uploads[1]).toBe(`${c.jobId}#0,${c.jobId}#1`);
      for (const [job, batchId] of [
        [a, 'batch_openai'],
        [b, 'batch_openai'],
        [c, 'batches/gemini-1'],
      ] as const) {
        expect(await jobOf(job.jobId)).toMatchObject({
          status: 'submitted',
          batchId,
          submittedAt: NOW.toISOString(),
          GSI1PK: 'JOBS#submitted',
          GSI1SK: NOW.toISOString(),
          attempts: 1,
        });
      }
    });

    it('never sends a job twice: a second run finds nothing scheduled', async () => {
      const batches = stubBatches();
      const job = await scheduled(newUser());
      await submitBatches(deps(batches.provider));
      expect(await submitBatches(deps(batches.provider))).toEqual({
        done: [],
        refunded: [],
        errors: [],
        batches: [],
      });
      expect(batches.submitted).toHaveLength(1);
      expect(batches.submitted[0]!.items.map((entry) => entry.key)).toEqual([job.jobId]);
      expect(batches.submitted[0]!.items[0]!.request).toEqual({
        prompt: expect.stringContaining('A lighthouse at dusk'),
        aspect: '1:1',
        quality: 'draft',
        count: 1,
      });
    });

    it('blocks and refunds a job moderation flags, and leaves one for later when moderation is down', async () => {
      const batches = stubBatches();
      const sub = newUser();
      const flagged = await scheduled(sub, {
        request: generate({ delivery: 'batch', prompt: 'something flagged' }),
        usedBefore: 3,
      });
      const later = await scheduled(newUser(), {
        request: generate({ delivery: 'batch', prompt: 'moderation down' }),
      });
      const moderate: ModerateRequest = async ({ request }) => {
        if (request.prompt.includes('down')) throw new Error('moderation unavailable');
        return request.prompt.includes('flagged')
          ? { flagged: true, category: 'violence' }
          : { flagged: false };
      };

      const result = await submitBatches(deps(batches.provider, { moderate }));

      expect(result).toMatchObject({ refunded: [flagged.jobId], errors: [later.jobId], done: [] });
      expect(batches.submitted).toEqual([]);
      expect(await jobOf(flagged.jobId)).toMatchObject({
        status: 'blocked',
        error: { code: 'blocked', message: JOB_ERROR_MESSAGES.blocked },
      });
      expect(await usedOn(sub)).toBe(3);
      // The batch job took no concurrency slot, so none is given back.
      expect(await activeJobs(sub)).toBe(0);
      const blocks = await table.client.send(
        new QueryCommand({
          TableName: table.tableName,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :block)',
          ExpressionAttributeValues: { ':pk': userPk(sub), ':block': blockSk('') },
        }),
      );
      expect(blocks.Items).toHaveLength(1);
      expect((await jobOf(later.jobId))?.status).toBe('scheduled');
    });

    it('cools the account down after a third block in 24 hours, as the worker does', async () => {
      const batches = stubBatches();
      const sub = newUser();
      for (let n = 0; n < 3; n++) {
        await scheduled(sub, {
          request: generate({ delivery: 'batch', prompt: `something flagged ${n}` }),
          createdAt: minutesAgo(20 - n),
        });
      }
      const moderate: ModerateRequest = async () => ({ flagged: true, category: 'violence' });
      expect((await submitBatches(deps(batches.provider, { moderate }))).refunded).toHaveLength(3);
      expect((await item(userPk(sub), PROFILE_SK))?.cooldownUntil).toEqual(expect.any(String));
    });

    it('refunds the claimed jobs when the provider refuses the batch', async () => {
      const batches = stubBatches();
      batches.stub.submit = async () => {
        throw new ProviderError('HTTP 400');
      };
      const sub = newUser();
      const job = await scheduled(sub, { pointsReserved: 2, usedBefore: 1 });

      expect(await submitBatches(deps(batches.provider))).toMatchObject({
        refunded: [job.jobId],
        done: [],
      });
      expect(await jobOf(job.jobId)).toMatchObject({
        status: 'failed',
        error: { code: 'provider_error' },
        pointsCharged: 0,
      });
      expect(await jobOf(job.jobId)).not.toHaveProperty('GSI1PK');
      expect(await usedOn(sub)).toBe(1);
    });

    it('refunds jobs scheduled past the window, or for a model switched off or without batches', async () => {
      const batches = stubBatches();
      const old = await scheduled(newUser(), { createdAt: minutesAgo(DAY + 5) });
      const off = await scheduled(newUser(), {
        request: generate({ delivery: 'batch', modelId: 'gpt-image-1-mini' }),
        provider: 'openai',
      });
      const bedrock = await scheduled(newUser(), {
        request: generate({ delivery: 'batch', modelId: 'stable-image-core' }),
        provider: 'bedrock',
      });
      const models = devModels.map((model) =>
        model.id === 'gpt-image-1-mini' ? { ...model, enabled: false } : model,
      );

      const result = await submitBatches(deps(batches.provider, { models: async () => models }));

      expect(new Set(result.refunded)).toEqual(new Set([old.jobId, off.jobId, bedrock.jobId]));
      expect((await jobOf(old.jobId))?.error?.code).toBe('batch_expired');
      expect((await jobOf(off.jobId))?.error?.code).toBe('provider_error');
      expect((await jobOf(bedrock.jobId))?.error?.code).toBe('provider_error');
      expect(batches.submitted).toEqual([]);
    });

    it('drops a job whose account was deleted, writing nothing under the user', async () => {
      const batches = stubBatches();
      const sub = newUser();
      const job = await scheduled(sub, { createdAt: minutesAgo(DAY + 5) });
      await table.client.send(
        new DeleteCommand({ TableName: table.tableName, Key: { PK: userPk(sub), SK: PROFILE_SK } }),
      );
      await table.client.send(
        new DeleteCommand({
          TableName: table.tableName,
          Key: { PK: userPk(sub), SK: usageSk('2026-10-15') },
        }),
      );

      expect((await submitBatches(deps(batches.provider))).refunded).toEqual([job.jobId]);
      expect(await jobOf(job.jobId)).toMatchObject({ status: 'failed', pointsCharged: 0 });
      expect(await item(userPk(sub), usageSk('2026-10-15'))).toBeUndefined();
      expect(await item(userPk(sub), PROFILE_SK)).toBeUndefined();
    });
  });

  describe('poller', () => {
    it('leaves a running batch alone', async () => {
      const batches = stubBatches();
      const job = await submitted(newUser(), 'batch-1');
      expect(await pollBatches(deps(batches.provider))).toEqual({
        done: [],
        refunded: [],
        errors: [],
        batches: ['batch-1'],
      });
      expect((await jobOf(job.jobId))?.status).toBe('submitted');
    });

    it('records a completed OpenAI batch: images stored, half-price points settled', async () => {
      const png = await pngOf(1024, 1024);
      const image = { b64_json: Buffer.from(png).toString('base64') };
      const sub = newUser();
      const job = await submitted(sub, 'batch_1', {
        request: generate({
          delivery: 'batch',
          modelId: 'gpt-image-2',
          quality: 'standard',
          count: 2,
        }),
        provider: 'openai',
        // Standard is 6 points an image: 12 for two, 6 as a batch.
        pointsReserved: 6,
        usedBefore: 4,
      });
      server.use(
        http.get(`${OPENAI_URL}/batches/batch_1`, () =>
          HttpResponse.json({ id: 'batch_1', status: 'completed', output_file_id: 'file-out' }),
        ),
        http.get(`${OPENAI_URL}/files/file-out/content`, () =>
          HttpResponse.text(
            `${JSON.stringify({
              custom_id: job.jobId,
              response: { status_code: 200, body: { data: [image, image] } },
            })}\n`,
          ),
        ),
      );
      const metrics = vi.fn<EmitMetrics>();
      const factory = createBatchProviderFactory({
        openai: () => new OpenAiProvider({ apiKey: async () => 'sk', baseURL: OPENAI_URL }),
      });

      const result = await pollBatches({
        ...deps(stubBatches().provider, { metrics }),
        batchProvider: factory,
      });

      expect(result).toMatchObject({ done: [job.jobId], refunded: [], errors: [] });
      const done = await jobOf(job.jobId);
      // Without usage data the cost is the list price, 12 cents, at half price: 6 cents, 6 points.
      expect(done).toMatchObject({ status: 'succeeded', pointsCharged: 6, providerCostCents: 6 });
      expect(done?.images).toHaveLength(2);
      expect(done).not.toHaveProperty('GSI1PK');
      expect(await usedOn(sub)).toBe(10);
      expect(await activeJobs(sub)).toBe(0);
      for (const stored of done!.images!) {
        expect(await item(userPk(sub), imageSk(stored.imageId))).toMatchObject({
          title: 'A lighthouse at dusk',
          modelId: 'gpt-image-2',
        });
      }
      // A PNG and a thumbnail for each image.
      expect(s3.commandCalls(PutObjectCommand)).toHaveLength(4);
      expect(metrics).toHaveBeenCalledWith(
        expect.arrayContaining([{ name: 'JobsSucceeded', value: 1, unit: 'Count' }]),
      );
      expect(await item(statsPk('2026-10-15'), statsModelSk('gpt-image-2'))).toMatchObject({
        images: 2,
        points: 6,
      });
    });

    it('settles a partial failure: charges the images that came back, blocks a refusal, fails an error', async () => {
      const batches = stubBatches();
      const png = { png: await pngOf(64, 64), width: 64, height: 64 };
      const sub = newUser();
      const partial = await submitted(sub, 'batch-1', {
        request: generate({ delivery: 'batch', count: 2, quality: 'high' }),
        pointsReserved: 3,
      });
      const refused = await submitted(newUser(), 'batch-1');
      const broken = await submitted(newUser(), 'batch-1');
      const missing = await submitted(newUser(), 'batch-1');
      batches.stub.poll = async () => ({
        state: 'done',
        expired: false,
        results: new Map([
          [partial.jobId, { images: [png], providerCostCents: 1.5 }],
          [
            refused.jobId,
            { images: [], providerCostCents: 0, error: new ProviderSafetyError('no') },
          ],
          [broken.jobId, { images: [], providerCostCents: 0, error: new ProviderError('oops') }],
        ]),
      });

      const result = await pollBatches(deps(batches.provider));

      expect(result.done).toEqual([partial.jobId]);
      expect(new Set(result.refunded)).toEqual(
        new Set([refused.jobId, broken.jobId, missing.jobId]),
      );
      expect(batches.polled).toEqual(['batch-1']);
      // One of two images came back: half the reservation, 2 points, covers its 1.5 cents.
      expect(await jobOf(partial.jobId)).toMatchObject({ status: 'succeeded', pointsCharged: 2 });
      expect(await usedOn(sub)).toBe(2);
      expect(await jobOf(refused.jobId)).toMatchObject({
        status: 'blocked',
        error: { code: 'blocked' },
      });
      expect((await jobOf(broken.jobId))?.error?.code).toBe('provider_error');
      expect((await jobOf(missing.jobId))?.error?.code).toBe('batch_expired');
    });

    it('refunds the jobs an expired batch has no images for', async () => {
      const batches = stubBatches();
      const png = { png: await pngOf(64, 64), width: 64, height: 64 };
      const finished = await submitted(newUser(), 'batch-1');
      const sub = newUser();
      const unfinished = await submitted(sub, 'batch-1', { pointsReserved: 2, usedBefore: 5 });
      batches.stub.poll = async () => ({
        state: 'done',
        expired: true,
        results: new Map([
          [finished.jobId, { images: [png], providerCostCents: 0.5 }],
          [unfinished.jobId, { images: [], providerCostCents: 0, error: new ProviderError('x') }],
        ]),
      });

      expect(await pollBatches(deps(batches.provider))).toMatchObject({
        done: [finished.jobId],
        refunded: [unfinished.jobId],
      });
      expect(await jobOf(unfinished.jobId)).toMatchObject({
        status: 'failed',
        error: { code: 'batch_expired', message: JOB_ERROR_MESSAGES.batch_expired },
      });
      expect(await usedOn(sub)).toBe(5);
    });

    it('refunds every job of a failed batch', async () => {
      const batches = stubBatches();
      batches.stub.poll = async () => ({ state: 'failed', error: new ProviderError('bad file') });
      const a = await submitted(newUser(), 'batch-1');
      const b = await submitted(newUser(), 'batch-1');
      expect(new Set((await pollBatches(deps(batches.provider))).refunded)).toEqual(
        new Set([a.jobId, b.jobId]),
      );
      expect((await jobOf(a.jobId))?.error?.code).toBe('provider_error');
    });

    it('is safe to poll again: a finished job is not recorded twice', async () => {
      const provider = new MockProvider({ delayMs: 0 });
      const mock = devModels.find((model) => model.id === 'mock')!;
      const job = await scheduled(newUser());
      const batchId = await provider.submitBatch(mock, [
        {
          key: job.jobId,
          request: { prompt: 'A lighthouse at dusk', aspect: '1:1', quality: 'draft', count: 1 },
        },
      ]);
      await submitBatches(deps(provider));
      expect((await jobOf(job.jobId))?.batchId).toBe(batchId);

      expect((await pollBatches(deps(provider))).done).toEqual([job.jobId]);
      expect(await pollBatches(deps(provider))).toEqual({
        done: [],
        refunded: [],
        errors: [],
        batches: [],
      });
      expect(s3.commandCalls(PutObjectCommand)).toHaveLength(2);
      expect((await jobOf(job.jobId))?.status).toBe('succeeded');
    });

    it('refunds jobs of a batch still running past the window and its grace', async () => {
      const batches = stubBatches();
      const late = await submitted(newUser(), 'batch-1', {
        createdAt: new Date(NOW.getTime() - DAY * 60_000 - BATCH_GRACE_MS - 60_000).toISOString(),
      });
      const onTime = await submitted(newUser(), 'batch-1', { createdAt: minutesAgo(DAY) });

      expect((await pollBatches(deps(batches.provider))).refunded).toEqual([late.jobId]);
      expect((await jobOf(late.jobId))?.error?.code).toBe('batch_expired');
      expect((await jobOf(onTime.jobId))?.status).toBe('submitted');
    });

    it('retries a batch it cannot read, unless its jobs are overdue', async () => {
      const batches = stubBatches();
      batches.stub.poll = async () => {
        throw new ProviderError('HTTP 503', { retryable: true });
      };
      const job = await submitted(newUser(), 'batch-1');
      expect((await pollBatches(deps(batches.provider))).errors).toEqual([job.jobId]);
      expect((await jobOf(job.jobId))?.status).toBe('submitted');
    });

    it('refunds a submitted job that never got a batch ID', async () => {
      const batches = stubBatches();
      const stale = await submitted(newUser(), '', {
        submittedAt: new Date(NOW.getTime() - UNRECORDED_BATCH_MS - 60_000).toISOString(),
      });
      const fresh = await submitted(newUser(), '', { submittedAt: minutesAgo(5) });

      expect((await pollBatches(deps(batches.provider))).refunded).toEqual([stale.jobId]);
      expect((await jobOf(fresh.jobId))?.status).toBe('submitted');
      expect(batches.polled).toEqual([]);
    });

    it('drops a job whose account was deleted, and removes its stored images', async () => {
      const batches = stubBatches();
      const png = { png: await pngOf(64, 64), width: 64, height: 64 };
      const sub = newUser();
      const job = await submitted(sub, 'batch-1');
      await table.client.send(
        new DeleteCommand({ TableName: table.tableName, Key: { PK: userPk(sub), SK: PROFILE_SK } }),
      );
      batches.stub.poll = async () => ({
        state: 'done',
        expired: false,
        results: new Map([[job.jobId, { images: [png], providerCostCents: 0.5 }]]),
      });

      expect((await pollBatches(deps(batches.provider))).refunded).toEqual([job.jobId]);
      expect(await jobOf(job.jobId)).toMatchObject({ status: 'failed', pointsCharged: 0 });
      expect(s3.commandCalls(DeleteObjectCommand)).toHaveLength(2);
      expect(await item(userPk(sub), PROFILE_SK)).toBeUndefined();
    });
  });
});
