import type { CreateJobRequest } from './schemas.js';

/**
 * Job states (tech design 5.2). Batch jobs (tech design 5.4) wait as `scheduled` for the batch submitter, then as
 * `submitted` while the provider batch runs, instead of `queued` and `running`.
 */
export const JOB_STATUSES = [
  'queued',
  'running',
  'scheduled',
  'submitted',
  'succeeded',
  'failed',
  'blocked',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** States a job never leaves. */
export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ['succeeded', 'failed', 'blocked'];

export const JOB_TYPES = ['generate', 'edit'] as const;
export type JobType = (typeof JOB_TYPES)[number];

/** Per-user limits (LIM-3). */
export const MAX_ACTIVE_JOBS = 2;
export const RATE_LIMIT_PER_MINUTE = 10;

/** Item lifetimes (tech design 4). */
export const USAGE_TTL_DAYS = 35;
export const RATE_TTL_SECONDS = 120;
export const JOB_TTL_DAYS = 30;
export const STATS_TTL_DAYS = 400;

/** How a generate job is delivered: straight away, or through a provider batch at half the points (P1). */
export const DELIVERIES = ['standard', 'batch'] as const;
export type Delivery = (typeof DELIVERIES)[number];

/** Statuses of a batch job before it finishes (tech design 5.4). */
export const BATCH_JOB_STATUSES = ['scheduled', 'submitted'] as const;
export type BatchJobStatus = (typeof BATCH_JOB_STATUSES)[number];

/** The provider batch window: a batch job still unfinished this long after it was created is refunded. */
export const BATCH_WINDOW_MS = 24 * 60 * 60_000;

/** How often the batch submitter and poller run (tech design 5.4). */
export const BATCH_INTERVAL_MINUTES = 15;

/** Most jobs sent in one provider batch; more wait for the next run. */
export const MAX_BATCH_JOBS = 200;

/** The sweeper fails jobs stuck this long, with a refund (tech design 3.2). */
export const STUCK_RUNNING_MS = 5 * 60_000;
export const STUCK_QUEUED_MS = 10 * 60_000;

/** Why a job failed or was blocked; each has a plain-language message for the user (GEN-10). */
export const JOB_ERROR_CODES = [
  'blocked',
  'timeout',
  'provider_error',
  'enqueue_failed',
  'stuck',
  'source_missing',
  'batch_expired',
] as const;
export type JobErrorCode = (typeof JOB_ERROR_CODES)[number];

export const JOB_ERROR_MESSAGES: Readonly<Record<JobErrorCode, string>> = {
  blocked:
    'This request was blocked by our content policy. Your points have been refunded. Try rewording the prompt.',
  timeout:
    'The image model took too long to answer. Your points have been refunded. Please try again.',
  provider_error:
    'The image model ran into a problem. Your points have been refunded. Please try again, or pick another model.',
  enqueue_failed: "We couldn't start your job. Your points have been refunded. Please try again.",
  stuck: "Your job didn't finish in time. Your points have been refunded. Please try again.",
  source_missing:
    'The image you were editing, or one of its reference images, is no longer available. Your points have been refunded.',
  batch_expired:
    "Your scheduled images weren't ready within 24 hours. Your points have been refunded. Please try again.",
};

export interface JobError {
  code: JobErrorCode;
  message: string;
}

export function jobError(code: JobErrorCode): JobError {
  return { code, message: JOB_ERROR_MESSAGES[code] };
}

/** An image a succeeded job produced: version `version` of image `imageId`, stored at `s3Key`. */
export interface JobImage {
  imageId: string;
  version: number;
  s3Key: string;
}

/** The `JOB#<jobId>` / `META` item (tech design 4). */
export interface JobItem {
  PK: string;
  SK: string;
  jobId: string;
  userId: string;
  type: JobType;
  status: JobStatus;
  request: CreateJobRequest;
  modelId: string;
  provider: string;
  pointsReserved: number;
  /** The `USAGE#<date>` the points were reserved against, so a refund after midnight finds them. */
  usageDate: string;
  createdAt: string;
  attempts: number;
  pointsCharged?: number;
  providerCostCents?: number;
  error?: JobError;
  images?: JobImage[];
  startedAt?: string;
  finishedAt?: string;
  /** Batch jobs: when the submitter put the job in a provider batch. */
  submittedAt?: string;
  /** Batch jobs: the provider's ID of the batch the job is in, set once the provider accepted it. */
  batchId?: string;
  /**
   * `JOBS#<status>` while the job is queued, running, scheduled or submitted, so the sweeper and the batch
   * Lambdas can find it; removed after.
   */
  GSI1PK?: string;
  /**
   * When the job entered its current active status: `createdAt` while queued or scheduled, `startedAt` while
   * running, `submittedAt` while submitted.
   */
  GSI1SK?: string;
  ttl: number;
}

/** Statuses a job is in before it finishes; each has its own `JOBS#<status>` index partition. */
export type ActiveJobStatus = 'queued' | 'running' | BatchJobStatus;

/** True for a job delivered through a provider batch (tech design 5.4). */
export function isBatchJob(job: Pick<JobItem, 'request'>): boolean {
  return job.request.type === 'generate' && job.request.delivery === 'batch';
}

/** Keys of the single table (tech design 4). */
export const PROFILE_SK = 'PROFILE';
export const JOB_SK = 'META';

export function userPk(sub: string): string {
  return `USER#${sub}`;
}

export function usageSk(date: string): string {
  return `USAGE#${date}`;
}

export function rateSk(minute: string): string {
  return `RATE#${minute}`;
}

export function jobPk(jobId: string): string {
  return `JOB#${jobId}`;
}

/** The GSI1 partition holding every job in an active status (tech design 4: the sweeper and batch Lambdas). */
export function activeJobsGsiPk(status: ActiveJobStatus): string {
  return `JOBS#${status}`;
}

export function imageSk(imageId: string): string {
  return `IMG#${imageId}`;
}

export function versionSk(imageId: string, version: number): string {
  return `VER#${imageId}#${version}`;
}

export const PLATFORM_PK = 'PLATFORM';

export function spendSk(month: string): string {
  return `SPEND#${month}`;
}

export function statsPk(date: string): string {
  return `STATS#${date}`;
}

export function statsModelSk(modelId: string): string {
  return `MODEL#${modelId}`;
}

/** Prompt enhancer overhead for the day, per enhancer model (`bedrock:<id>`, `gemini:<id>` or `mock`). */
export function statsEnhancerSk(enhancerModel: string): string {
  return `ENHANCER#${enhancerModel}`;
}

/** Digits in a usage item's `GSI1SK`, so the ADM-3 top-users query sorts by points used. */
export const USAGE_RANK_DIGITS = 10;

/** A usage item's `GSI1SK`: points used, zero-padded. */
export function usageRankSk(used: number): string {
  return String(Math.max(0, Math.trunc(used))).padStart(USAGE_RANK_DIGITS, '0');
}

/** The UTC day, `yyyy-mm-dd`, that daily points are counted against. */
export function utcDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** The UTC month, `yyyy-mm`, that platform spend is counted against. */
export function utcMonth(now: Date): string {
  return now.toISOString().slice(0, 7);
}

/** The UTC minute, `yyyymmddHHMM`, of the rate-limit window. */
export function utcMinute(now: Date): string {
  return now.toISOString().slice(0, 16).replace(/[-T:]/g, '');
}

/** A DynamoDB `ttl` value: epoch seconds `seconds` after `now`. */
export function ttlAfter(now: Date, seconds: number): number {
  return Math.floor(now.getTime() / 1000) + seconds;
}

export const SECONDS_PER_DAY = 86_400;

/** Where the worker stores version `version` of an image (tech design 9). */
export function imageKey(sub: string, imageId: string, version: number): string {
  return `users/${sub}/${imageId}/v${version}.png`;
}

/** Where the browser uploads an image to edit (EDIT-2, tech design 9); unused uploads expire after a day. */
export function uploadKey(sub: string, uploadId: string): string {
  return `uploads/${sub}/${uploadId}`;
}

/** Where the worker stores the WebP thumbnail of version `version` of an image (tech design 9). */
export function thumbnailKey(sub: string, imageId: string, version: number): string {
  return `users/${sub}/${imageId}/v${version}_thumb.webp`;
}
