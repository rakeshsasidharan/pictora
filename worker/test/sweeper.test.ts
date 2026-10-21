import type { EmitMetrics } from '@pictora/core/observability';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import {
  JOB_ERROR_MESSAGES,
  JOB_SK,
  PROFILE_SK,
  jobPk,
  statsModelSk,
  statsPk,
  usageSk,
  userPk,
} from '@pictora/core';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claimJob } from '../src/job_store.js';
import { processJob } from '../src/pipeline.js';
import { sweepStuckJobs } from '../src/sweeper.js';
import { DYNAMODB_ENDPOINT, localTable } from './dynamodb_local.js';
import { countingMock, generate, getItem, newUser, pipelineDeps, seedJob } from './helpers.js';

const s3 = mockClient(S3Client);
const NOW = new Date('2026-10-15T12:30:00.000Z');
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

describe.skipIf(!DYNAMODB_ENDPOINT)('sweepStuckJobs', () => {
  let table: ReturnType<typeof localTable>;

  beforeEach(async () => {
    table = localTable('pictora-sweeper');
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
  const usedOn = async (sub: string) => (await item(userPk(sub), usageSk('2026-10-15')))?.used;
  const activeJobs = async (sub: string) => (await item(userPk(sub), PROFILE_SK))?.activeJobs;
  const sweep = () => sweepStuckJobs({ ...table, now: () => NOW });

  it('fails and refunds a job running for over 5 minutes', async () => {
    const sub = newUser();
    const job = await seedJob(table.client, table.tableName, sub, {
      status: 'running',
      request: generate({ quality: 'high', count: 2 }),
      pointsReserved: 6,
      usedBefore: 2,
      createdAt: minutesAgo(7),
      startedAt: minutesAgo(6),
    });

    expect(await sweep()).toEqual({ swept: [job.jobId], skipped: [], errors: [] });
    const done = await jobOf(job.jobId);
    expect(done).toMatchObject({
      status: 'failed',
      error: { code: 'stuck', message: JOB_ERROR_MESSAGES.stuck },
      pointsCharged: 0,
      finishedAt: NOW.toISOString(),
    });
    expect(done).not.toHaveProperty('GSI1PK');
    expect(await usedOn(sub)).toBe(2);
    expect(await activeJobs(sub)).toBe(0);
    expect(await item(statsPk('2026-10-15'), statsModelSk('mock'))).toMatchObject({ failures: 1 });
  });

  it('counts each swept job as a failed job', async () => {
    const job = await seedJob(table.client, table.tableName, newUser(), {
      createdAt: minutesAgo(11),
    });
    const metrics = vi.fn<EmitMetrics>();
    const result = await sweepStuckJobs({ ...table, now: () => NOW, metrics });
    expect(result.swept).toEqual([job.jobId]);
    expect(metrics).toHaveBeenCalledWith([{ name: 'JobsFailed', value: 1, unit: 'Count' }]);
  });

  it('fails and refunds a job queued for over 10 minutes', async () => {
    const sub = newUser();
    const job = await seedJob(table.client, table.tableName, sub, { createdAt: minutesAgo(11) });
    expect(await sweep()).toEqual({ swept: [job.jobId], skipped: [], errors: [] });
    expect(await jobOf(job.jobId)).toMatchObject({ status: 'failed', error: { code: 'stuck' } });
    expect(await usedOn(sub)).toBe(0);
    expect(await activeJobs(sub)).toBe(0);
  });

  it('leaves jobs that are not stuck yet, and finished jobs, alone', async () => {
    const running = await seedJob(table.client, table.tableName, newUser(), {
      status: 'running',
      createdAt: minutesAgo(5),
      startedAt: minutesAgo(4),
    });
    const queued = await seedJob(table.client, table.tableName, newUser(), {
      createdAt: minutesAgo(9),
    });
    const finished = await seedJob(table.client, table.tableName, newUser(), {
      status: 'succeeded',
      createdAt: minutesAgo(30),
      startedAt: minutesAgo(29),
    });

    expect(await sweep()).toEqual({ swept: [], skipped: [], errors: [] });
    expect((await jobOf(running.jobId))?.status).toBe('running');
    expect((await jobOf(queued.jobId))?.status).toBe('queued');
    expect((await jobOf(finished.jobId))?.status).toBe('succeeded');
  });

  it('refunds a stuck job once, however many times it is swept', async () => {
    const sub = newUser();
    await seedJob(table.client, table.tableName, sub, {
      status: 'running',
      pointsReserved: 1,
      usedBefore: 3,
      startedAt: minutesAgo(8),
    });
    expect((await sweep()).swept).toHaveLength(1);
    expect(await sweep()).toEqual({ swept: [], skipped: [], errors: [] });
    expect(await usedOn(sub)).toBe(3);
    expect(await activeJobs(sub)).toBe(0);
  });

  it('never sends a swept job to the provider, even when its message arrives later', async () => {
    const sub = newUser();
    const job = await seedJob(table.client, table.tableName, sub, { createdAt: minutesAgo(12) });
    await sweep();
    const { provider, calls } = countingMock();
    expect(await processJob(pipelineDeps(table.client, table.tableName, provider), job.jobId)).toBe(
      'skipped',
    );
    expect(calls()).toBe(0);
    expect(await usedOn(sub)).toBe(0);
  });

  it('sweeps a job a killed worker left running', async () => {
    const sub = newUser();
    const job = await seedJob(table.client, table.tableName, sub, {
      request: generate({ quality: 'standard' }),
      pointsReserved: 2,
      createdAt: minutesAgo(9),
    });
    // The worker claims the job, then dies before the provider answers.
    expect(await claimJob(table, job.jobId, new Date(minutesAgo(8)))).toBeDefined();

    expect((await sweep()).swept).toEqual([job.jobId]);
    expect(await jobOf(job.jobId)).toMatchObject({ status: 'failed', attempts: 1 });
    expect(await usedOn(sub)).toBe(0);
    expect(await activeJobs(sub)).toBe(0);
  });

  it('reports a refund that throws and carries on with the other jobs', async () => {
    const first = await seedJob(table.client, table.tableName, newUser(), {
      createdAt: minutesAgo(20),
    });
    const second = await seedJob(table.client, table.tableName, newUser(), {
      createdAt: minutesAgo(15),
    });
    const send = table.client.send.bind(table.client);
    let failed = false;
    vi.spyOn(table.client, 'send').mockImplementation(async (command: unknown) => {
      if (command instanceof TransactWriteCommand && !failed) {
        failed = true;
        throw new Error('throttled');
      }
      return send(command as never);
    });
    expect(await sweep()).toEqual({ swept: [second.jobId], skipped: [], errors: [first.jobId] });
    expect((await jobOf(first.jobId))?.status).toBe('queued');
  });
});
