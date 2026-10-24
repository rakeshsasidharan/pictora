import { S3Client } from '@aws-sdk/client-s3';
import { GetCommand, PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  JOB_SK,
  JOB_TTL_DAYS,
  PROFILE_SK,
  SECONDS_PER_DAY,
  activeJobsGsiPk,
  isBatchJob,
  jobPk,
  loadSeedRegistry,
  ttlAfter,
  usageSk,
  userPk,
  type CreateJobRequest,
  type EditJobRequest,
  type GenerateJobRequest,
  type JobItem,
  type ModelConfig,
} from '@pictora/core';
import { modelsAvailableIn } from '@pictora/core/registry-store';
import { MockProvider, createProviderFactory, type ImageProvider } from '@pictora/providers';
import sharp from 'sharp';
import { ulid } from 'ulid';
import type { PipelineDeps } from '../src/pipeline.js';

export const devModels = modelsAvailableIn(loadSeedRegistry(), 'dev');

export function model(id: string): ModelConfig {
  const found = devModels.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no ${id} in the dev registry`);
  return found;
}

/** A generate request for the mock model: draft costs 1 point an image, standard 2, high 3. */
export function generate(overrides: Partial<GenerateJobRequest> = {}): GenerateJobRequest {
  return {
    type: 'generate',
    prompt: 'A lighthouse at dusk',
    style: 'photorealistic',
    modelId: 'mock',
    aspect: '1:1',
    quality: 'draft',
    count: 1,
    ...overrides,
  };
}

let userCounter = 0;
export function newUser(): string {
  userCounter += 1;
  return `user-${userCounter}-${Date.now()}`;
}

/** An edit of version 1 of `imageId` with the mock model at draft quality (1 point). */
export function edit(imageId: string, overrides: Partial<EditJobRequest> = {}): EditJobRequest {
  return {
    type: 'edit',
    imageId,
    parentVersion: 1,
    instruction: 'Make it night',
    modelId: 'mock',
    quality: 'draft',
    ...overrides,
  };
}

export interface SeedOptions {
  request?: CreateJobRequest;
  pointsReserved?: number;
  usageDate?: string;
  createdAt?: string;
  /** Points the user had already used that day, apart from this job. */
  usedBefore?: number;
  status?: JobItem['status'];
  startedAt?: string;
  provider?: string;
  /** Batch jobs: when the job was put in a provider batch, and the batch's ID. */
  submittedAt?: string;
  batchId?: string;
}

/**
 * Writes what the job API leaves behind after a reservation: the profile with one active job (none for a batch
 * job, which takes no slot), the day's usage including this job's points, and the queued job on the active-jobs
 * index. A `scheduled` or `submitted` batch job is indexed under its own status.
 */
export async function seedJob(
  client: DynamoDBDocumentClient,
  tableName: string,
  sub: string,
  options: SeedOptions = {},
): Promise<JobItem> {
  const request = options.request ?? generate();
  const pointsReserved = options.pointsReserved ?? (request.type === 'edit' ? 1 : request.count);
  const usageDate = options.usageDate ?? '2026-10-15';
  const createdAt = options.createdAt ?? '2026-10-15T12:00:00.000Z';
  const status = options.status ?? 'queued';
  const jobId = ulid();
  const job: JobItem = {
    PK: jobPk(jobId),
    SK: JOB_SK,
    jobId,
    userId: sub,
    type: request.type,
    status,
    request,
    modelId: request.modelId,
    provider: options.provider ?? 'mock',
    pointsReserved,
    usageDate,
    createdAt,
    attempts: status === 'queued' || status === 'scheduled' ? 0 : 1,
    ...(status === 'queued' ||
    status === 'running' ||
    status === 'scheduled' ||
    status === 'submitted'
      ? {
          GSI1PK: activeJobsGsiPk(status),
          GSI1SK:
            status === 'running'
              ? (options.startedAt ?? createdAt)
              : status === 'submitted'
                ? (options.submittedAt ?? createdAt)
                : createdAt,
        }
      : {}),
    ...(options.startedAt ? { startedAt: options.startedAt } : {}),
    ...(options.submittedAt ? { submittedAt: options.submittedAt } : {}),
    ...(options.batchId ? { batchId: options.batchId } : {}),
    ttl: ttlAfter(new Date(createdAt), JOB_TTL_DAYS * SECONDS_PER_DAY),
  };
  await client.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        PK: userPk(sub),
        SK: PROFILE_SK,
        status: 'active',
        activeJobs: isBatchJob({ request }) ? 0 : 1,
      },
    }),
  );
  await client.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        PK: userPk(sub),
        SK: usageSk(usageDate),
        used: (options.usedBefore ?? 0) + pointsReserved,
        GSI1PK: `USAGE#${usageDate}`,
      },
    }),
  );
  await client.send(new PutCommand({ TableName: tableName, Item: job }));
  return job;
}

export async function getItem(
  client: DynamoDBDocumentClient,
  tableName: string,
  PK: string,
  SK: string,
): Promise<Record<string, unknown> | undefined> {
  return (await client.send(new GetCommand({ TableName: tableName, Key: { PK, SK } }))).Item;
}

/** A mock provider with no delay that counts its calls. */
export function countingMock(): { provider: ImageProvider; calls: () => number } {
  const mock = new MockProvider({ delayMs: 0 });
  let count = 0;
  return {
    provider: {
      generate: (m, req) => {
        count += 1;
        return mock.generate(m, req);
      },
      edit: (m, req) => mock.edit(m, req),
    },
    calls: () => count,
  };
}

/** A solid-colour PNG. */
export async function pngOf(width: number, height: number): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({
      create: { width, height, channels: 3, background: { r: 40, g: 90, b: 160 } },
    })
      .png()
      .toBuffer(),
  );
}

/** Pipeline deps over a local table, with the given adapter for every provider and no retry delay. */
export function pipelineDeps(
  client: DynamoDBDocumentClient,
  tableName: string,
  adapter: ImageProvider,
  overrides: Partial<PipelineDeps> = {},
): PipelineDeps {
  const factory = createProviderFactory({
    adapters: { mock: () => adapter, openai: () => adapter },
    retry: { delayMs: 0, jitterMs: 0 },
  });
  return {
    client,
    tableName,
    s3: new S3Client({
      region: 'us-west-2',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    }),
    bucket: 'pictora-test-images',
    models: async () => devModels,
    provider: factory,
    now: () => new Date('2026-10-15T12:00:30.000Z'),
    newImageId: () => ulid(),
    ...overrides,
  };
}
