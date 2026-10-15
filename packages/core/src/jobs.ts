import type { CreateJobRequest } from './schemas.js';

/** Job states (tech design 5.2). */
export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'blocked'] as const;
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

/** Why a job failed or was blocked; each has a plain-language message for the user (GEN-10). */
export const JOB_ERROR_CODES = [
  'blocked',
  'timeout',
  'provider_error',
  'enqueue_failed',
  'stuck',
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
  ttl: number;
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

/** The UTC day, `yyyy-mm-dd`, that daily points are counted against. */
export function utcDate(now: Date): string {
  return now.toISOString().slice(0, 10);
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
