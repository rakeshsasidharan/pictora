import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  JOB_SK,
  METRICS_COUNTS_SK,
  METRICS_SUMMARY_SK,
  PROFILE_SK,
  STATS_MODERATION_SK,
  activeUserSk,
  jobPk,
  metricsPk,
  statsEnhancerSk,
  statsModelSk,
  statsPk,
  ttfiSk,
  userPk,
  versionSk,
} from '@pictora/core';
import { recordGeneration } from '@pictora/core/metrics-store';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { refundJob } from '../src/job_store.js';
import { processJob } from '../src/pipeline.js';
import { purgeAccount } from '../src/purge.js';
import { computeSummaries } from '../src/success_metrics.js';
import { DYNAMODB_ENDPOINT, localTable } from './dynamodb_local.js';
import { countingMock, generate, getItem, newUser, pipelineDeps, seedJob } from './helpers.js';

const s3 = mockClient(S3Client);

describe.skipIf(!DYNAMODB_ENDPOINT)('success metrics', () => {
  let table: ReturnType<typeof localTable>;

  beforeEach(async () => {
    table = localTable('pictora-metrics');
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

  const put = (Item: Record<string, unknown>) =>
    table.client.send(new PutCommand({ TableName: table.tableName, Item }));
  const item = (pk: string, sk: string) => getItem(table.client, table.tableName, pk, sk);
  const counts = (date: string) => item(metricsPk(date), METRICS_COUNTS_SK);
  const signedUpAt = (sub: string, createdAt: string) =>
    table.client.send(
      new UpdateCommand({
        TableName: table.tableName,
        Key: { PK: userPk(sub), SK: PROFILE_SK },
        UpdateExpression: 'SET createdAt = :at',
        ExpressionAttributeValues: { ':at': createdAt },
      }),
    );

  describe('computeSummaries', () => {
    const NOW = new Date('2026-10-22T00:30:00.000Z');
    const run = () => computeSummaries({ ...table, now: () => NOW });

    /** The seeded test day of the core formula tests, as the items the app and worker write. */
    async function seedTestDay() {
      await put({
        PK: metricsPk('2026-10-14'),
        SK: METRICS_COUNTS_SK,
        signups: 10,
        firstSessionGenerates: 7,
        returnGenerates: 3,
        imagesGenerated: 40,
        imagesDiscarded: 30,
        jobsSucceeded: 49,
        jobsFailed: 1,
        jobsBlocked: 3,
      });
      for (const [index, ms] of [90_000, 30_000, 50_000, 45_000].entries()) {
        await put({ PK: metricsPk('2026-10-14'), SK: ttfiSk(`new-${index}`), ms });
      }
      // $14.00 over the week ending on the 14th: provider spend and enhancer overhead on two days...
      await put({
        PK: statsPk('2026-10-14'),
        SK: statsModelSk('gpt-image-2'),
        providerCostCents: 900,
      });
      await put({ PK: statsPk('2026-10-14'), SK: statsEnhancerSk('gemini-flash'), costCents: 100 });
      await put({ PK: statsPk('2026-10-08'), SK: statsModelSk('mock'), providerCostCents: 400 });
      // ...but not the day before the week.
      await put({ PK: statsPk('2026-10-07'), SK: statsModelSk('mock'), providerCostCents: 9999 });
      await put({
        PK: statsPk('2026-10-14'),
        SK: STATS_MODERATION_SK,
        blocksReviewed: 50,
        falseBlocks: 1,
      });
      // 8 distinct users active in the week, one of them on two days; one more active only before it.
      for (let user = 0; user < 8; user++) {
        await put({
          PK: metricsPk(user < 4 ? '2026-10-14' : '2026-10-09'),
          SK: activeUserSk(`u${user}`),
        });
      }
      await put({ PK: metricsPk('2026-10-10'), SK: activeUserSk('u0') });
      await put({ PK: metricsPk('2026-10-07'), SK: activeUserSk('earlier') });
    }

    it('summarises the seeded test day as the hand calculation does', async () => {
      await seedTestDay();
      await run();
      const summary = await item(metricsPk('2026-10-14'), METRICS_SUMMARY_SK);
      expect(summary).toMatchObject({
        date: '2026-10-14',
        computedAt: '2026-10-22T00:30:00.000Z',
        activation: { value: 0.7, numerator: 7, denominator: 10 },
        keepRate: { value: 0.25, numerator: 10, denominator: 40 },
        timeToFirstImage: { value: 47_500, samplesMs: [30_000, 45_000, 50_000, 90_000] },
        generationSuccess: { value: 0.98, numerator: 49, denominator: 50 },
        weekOneRetention: { value: 0.3, numerator: 3, denominator: 10 },
        costPerActiveUser: { value: 175, spendCents: 1400, activeUsers: 8 },
        falseBlocks: { value: 0.02, numerator: 1, denominator: 50 },
      });
      expect(summary?.ttl).toEqual(expect.any(Number));
    });

    it('summarises the 8 days before today, leaving keep rate and retention open for the newer 7', async () => {
      const summaries = await run();
      expect(summaries.map((summary) => summary.date)).toEqual([
        '2026-10-21',
        '2026-10-20',
        '2026-10-19',
        '2026-10-18',
        '2026-10-17',
        '2026-10-16',
        '2026-10-15',
        '2026-10-14',
      ]);
      expect(summaries.slice(0, 7).every((summary) => summary.keepRate === null)).toBe(true);
      expect(summaries[7]?.keepRate).not.toBeNull();
      expect(await item(metricsPk('2026-10-22'), METRICS_SUMMARY_SK)).toBeUndefined();
    });

    it('gives the same summaries when run again', async () => {
      await seedTestDay();
      await run();
      const first = await item(metricsPk('2026-10-14'), METRICS_SUMMARY_SK);
      await run();
      expect(await item(metricsPk('2026-10-14'), METRICS_SUMMARY_SK)).toEqual(first);
      // The counters it reads are untouched.
      expect((await counts('2026-10-14'))?.signups).toBe(10);
    });
  });

  describe('job events', () => {
    it('counts a succeeded job and its images, the user active, and a first-session generation', async () => {
      const sub = newUser();
      const job = await seedJob(table.client, table.tableName, sub, {
        request: generate({ count: 2 }),
        createdAt: '2026-10-15T12:00:00.000Z',
      });
      await signedUpAt(sub, '2026-10-15T11:20:00.000Z');
      const { provider } = countingMock();
      expect(
        await processJob(pipelineDeps(table.client, table.tableName, provider), job.jobId),
      ).toBe('succeeded');
      expect(await counts('2026-10-15')).toMatchObject({
        jobsSucceeded: 1,
        imagesGenerated: 2,
        firstSessionGenerates: 1,
      });
      expect(await item(metricsPk('2026-10-15'), activeUserSk(sub))).toBeDefined();
      expect((await item(userPk(sub), PROFILE_SK))?.firstSessionAt).toBe(
        '2026-10-15T12:00:30.000Z',
      );
    });

    it('counts a failed job, and a blocked one apart from it', async () => {
      const now = new Date('2026-10-15T12:10:00.000Z');
      for (const status of ['failed', 'blocked'] as const) {
        const job = await seedJob(table.client, table.tableName, newUser(), { status: 'running' });
        expect(
          await refundJob(table, {
            job,
            from: 'running',
            status,
            error: { code: 'provider_error', message: 'Something went wrong.' },
            now,
          }),
        ).toBe(true);
        // A second refund of the same job writes nothing.
        expect(
          await refundJob(table, {
            job,
            from: 'running',
            status,
            error: { code: 'provider_error', message: 'Something went wrong.' },
            now,
          }),
        ).toBe(false);
        expect((await item(jobPk(job.jobId), JOB_SK))?.status).toBe(status);
      }
      expect(await counts('2026-10-15')).toMatchObject({ jobsFailed: 1, jobsBlocked: 1 });
    });

    it('counts a return within 7 days on the sign-up day, once, and nothing after 7 days', async () => {
      const sub = newUser();
      await put({ PK: userPk(sub), SK: PROFILE_SK, createdAt: '2026-10-10T09:00:00.000Z' });
      const now = new Date('2026-10-12T10:00:00.000Z');
      expect(await recordGeneration(table, sub, '2026-10-12T09:59:00.000Z', now)).toEqual({
        firstSession: false,
        returned: true,
      });
      expect(await recordGeneration(table, sub, '2026-10-13T09:59:00.000Z', now)).toEqual({
        firstSession: false,
        returned: false,
      });
      expect((await counts('2026-10-10'))?.returnGenerates).toBe(1);

      const late = newUser();
      await put({ PK: userPk(late), SK: PROFILE_SK, createdAt: '2026-10-01T09:00:00.000Z' });
      expect(await recordGeneration(table, late, '2026-10-12T09:59:00.000Z', now)).toEqual({
        firstSession: false,
        returned: false,
      });
      expect(await counts('2026-10-01')).toBeUndefined();
    });

    it('counts a first-session generation once, however many jobs the user runs', async () => {
      const sub = newUser();
      await put({ PK: userPk(sub), SK: PROFILE_SK, createdAt: '2026-10-15T08:00:00.000Z' });
      const now = new Date('2026-10-15T08:30:00.000Z');
      await recordGeneration(table, sub, '2026-10-15T08:10:00.000Z', now);
      await recordGeneration(table, sub, '2026-10-15T08:20:00.000Z', now);
      expect((await counts('2026-10-15'))?.firstSessionGenerates).toBe(1);
    });
  });

  describe('account purge', () => {
    it('counts recent generated images never downloaded as discarded, on the day they were made', async () => {
      const sub = newUser();
      await put({ PK: userPk(sub), SK: PROFILE_SK, status: 'deleting', activeJobs: 0 });
      const version = (n: number, extra: Record<string, unknown>) =>
        put({
          PK: userPk(sub),
          SK: versionSk('01JAAAAAAAAAAAAAAAAAAAAAAA', n),
          version: n,
          ...extra,
        });
      await version(1, { jobId: 'job-1', createdAt: '2026-10-14T10:00:00.000Z' });
      await version(2, { jobId: 'job-2', createdAt: '2026-10-15T10:00:00.000Z' });
      // Downloaded, uploaded, or older than 7 days: none of these count.
      await version(3, {
        jobId: 'job-3',
        createdAt: '2026-10-15T10:00:00.000Z',
        downloadedAt: '2026-10-15T11:00:00.000Z',
      });
      await version(4, { source: 'upload', createdAt: '2026-10-15T10:00:00.000Z' });
      await version(5, { jobId: 'job-5', createdAt: '2026-10-01T10:00:00.000Z' });
      s3.reset();
      s3.resolves({ Contents: [] });

      await purgeAccount(
        {
          client: table.client,
          tableName: table.tableName,
          s3: new S3Client({
            region: 'us-west-2',
            credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
          }),
          bucket: 'pictora-test-images',
          deleteUser: async () => undefined,
          requeue: async () => undefined,
          now: () => new Date('2026-10-16T09:00:00.000Z'),
        },
        { sub, username: sub },
      );
      expect((await counts('2026-10-14'))?.imagesDiscarded).toBe(1);
      expect((await counts('2026-10-15'))?.imagesDiscarded).toBe(1);
      expect(await counts('2026-10-01')).toBeUndefined();
      const left = await table.client.send(
        new QueryCommand({
          TableName: table.tableName,
          KeyConditionExpression: 'PK = :pk',
          ExpressionAttributeValues: { ':pk': userPk(sub) },
        }),
      );
      expect(left.Items).toEqual([]);
    });
  });
});
