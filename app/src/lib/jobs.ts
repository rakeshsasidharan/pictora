import { GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  JOB_SK,
  MAX_UPLOAD_BYTES,
  JOB_TTL_DAYS,
  SECONDS_PER_DAY,
  activeJobsGsiPk,
  createJobRequestSchema,
  estimatePoints,
  jobError,
  jobPk,
  nearestAspect,
  parseReferenceKey,
  pausedQuality,
  ttlAfter,
  userPk,
  utcDate,
  versionSk,
  type Aspect,
  type EditJobRequest,
  type GenerateJobRequest,
  type JobItem,
  type JobStatus,
  type ModelConfig,
  type Provider,
} from '@pictora/core';
import type { EmitMetrics } from '@pictora/core/observability';
import { failQueuedJob, readJob, readUsedPoints, reserveJob } from './job_store';
import { premiumPausedMessage, readPremiumPause } from './platform_spend';
import {
  dailyLimit,
  ensureProfile,
  inCooldown,
  onboardingComplete,
  readProfile,
  type Profile,
} from './profile';
import { log } from './observability';
import type { Session } from './session';
import { CONTACT_EMAIL } from './site';

/** What the job API needs, so tests can swap the queues, S3 and the clock. */
export interface JobsDeps {
  client: DynamoDBDocumentClient;
  tableName: string;
  /** The environment's registry, switched-off models included. */
  models: () => Promise<ModelConfig[]>;
  /** True when the provider has a queue to send jobs to. */
  hasQueue: (provider: Provider) => boolean;
  /** Sends `{ jobId }` to the provider's queue. */
  enqueue: (provider: Provider, jobId: string) => Promise<void>;
  /** A presigned GET URL for an object in the images bucket; with a download name, it saves as that file. */
  presign: (key: string, downloadName?: string) => Promise<string>;
  /** The size of an object in the images bucket, or undefined when it doesn't exist (reference uploads). */
  objectSize: (key: string) => Promise<number | undefined>;
  defaultDailyPoints: number;
  /** The monthly cap on platform provider spend, in cents (tech design 4.1). */
  spendCapCents: number;
  now: () => Date;
  newJobId: () => string;
  /** Publishes `JobsCreated` and `PointsReserved` (tech design 11) when set. */
  metrics?: EmitMetrics;
}

/** A route handler's answer: an HTTP status and a JSON body. */
export interface ApiResult {
  status: number;
  body: Record<string, unknown>;
}

/** Error codes the job API returns, with the HTTP status of each. */
export const API_ERROR_STATUS = {
  invalid_request: 400,
  unknown_model: 400,
  model_disabled: 400,
  unsupported_option: 400,
  upload_wrong_type: 400,
  not_an_image: 400,
  upload_too_large: 413,
  blocked: 422,
  out_of_points: 402,
  forbidden: 403,
  suspended: 403,
  premium_paused: 403,
  account_deleting: 403,
  onboarding_required: 403,
  cooldown: 403,
  not_found: 404,
  terms_changed: 409,
  invalid_state: 409,
  rate_limited: 429,
  too_many_jobs: 429,
  enqueue_failed: 503,
  enhance_failed: 503,
  deletion_failed: 503,
  moderation_failed: 503,
} as const;
export type ApiErrorCode = keyof typeof API_ERROR_STATUS;

/** An error answer with a plain-language message for the user (GEN-10). */
export function apiError(code: ApiErrorCode, message: string): ApiResult {
  return { status: API_ERROR_STATUS[code], body: { error: message, code } };
}

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** For example `16 October at 12:30`. */
const COOLDOWN_END_FORMAT = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'UTC',
});

/**
 * `POST /api/jobs` (tech design 5.1, 5.3): validates the request, checks it against the model, estimates its
 * points, reserves them with the limits in one transaction, and queues the job. Answers 202 with the job ID. An
 * edit must start from a version of the caller's own image, and costs one image at the chosen quality.
 */
export async function createJob(
  deps: JobsDeps,
  session: Session,
  input: unknown,
): Promise<ApiResult> {
  const parsed = createJobRequestSchema.safeParse(input);
  if (!parsed.success) {
    return apiError(
      'invalid_request',
      "Something in the request isn't valid. Check the prompt and options, then try again.",
    );
  }
  const request = parsed.data;

  const model = (await deps.models()).find((candidate) => candidate.id === request.modelId);
  if (!model) {
    return apiError('unknown_model', "That model isn't available. Pick another model.");
  }
  if (!model.enabled || !deps.hasQueue(model.provider)) {
    return apiError(
      'model_disabled',
      `${model.displayName} is switched off right now. Pick another model.`,
    );
  }
  let points: number;
  if (request.type === 'edit') {
    const unsupported = unsupportedEditOption(model, request);
    if (unsupported) return apiError('unsupported_option', unsupported);
    const aspect = await editAspect(deps, session, request, model);
    if (!aspect) return apiError('not_found', 'Image not found.');
    points = estimatePoints(model, request.quality, aspect, 1);
  } else {
    const unsupported = unsupportedOption(model, request);
    if (unsupported) return apiError('unsupported_option', unsupported);
    points = estimatePoints(model, request.quality, request.aspect, request.count);
  }

  const now = deps.now();
  if (pausedQuality(request.quality)) {
    const pause = await readPremiumPause(deps.client, deps.tableName, deps.spendCapCents, now);
    if (pause) return apiError('premium_paused', premiumPausedMessage(pause));
  }
  const profile = await ensureProfile(deps.client, deps.tableName, session, now);
  const blocked = profileRefusal(profile, now);
  if (blocked) return blocked;
  const limit = dailyLimit(profile, deps.defaultDailyPoints);
  const usageDate = utcDate(now);
  if (points > limit) return outOfPoints(deps, session.sub, usageDate, points);

  const jobId = deps.newJobId();
  const job: JobItem = {
    PK: jobPk(jobId),
    SK: JOB_SK,
    jobId,
    userId: session.sub,
    type: request.type,
    status: 'queued',
    request,
    modelId: model.id,
    provider: model.provider,
    pointsReserved: points,
    usageDate,
    createdAt: now.toISOString(),
    attempts: 0,
    // Indexed while queued, so the sweeper finds it if it's never picked up.
    GSI1PK: activeJobsGsiPk('queued'),
    GSI1SK: now.toISOString(),
    ttl: ttlAfter(now, JOB_TTL_DAYS * SECONDS_PER_DAY),
  };
  const reserved = await reserveJob(deps.client, deps.tableName, { job, limit, now });
  if (!reserved.ok) {
    if (reserved.reason === 'rate') {
      return apiError(
        'rate_limited',
        "You've started 10 jobs in the last minute. Wait a moment, then try again.",
      );
    }
    if (reserved.reason === 'points') return outOfPoints(deps, session.sub, usageDate, points);
    const current = await readProfile(deps.client, deps.tableName, session.sub);
    return (
      (current && profileRefusal(current, now)) ??
      apiError(
        'too_many_jobs',
        'You already have 2 jobs running. Wait for one to finish, then try again.',
      )
    );
  }

  try {
    await deps.enqueue(model.provider, jobId);
  } catch (error) {
    logError('Enqueue failed; refunding the job', { jobId, provider: model.provider, error });
    const failure = jobError('enqueue_failed');
    try {
      await failQueuedJob(deps.client, deps.tableName, job, failure, deps.now());
    } catch (refundError) {
      logError('Refund after enqueue failure failed', { jobId, error: refundError });
    }
    return apiError('enqueue_failed', failure.message);
  }
  deps.metrics?.([
    { name: 'JobsCreated', value: 1, unit: 'Count' },
    { name: 'PointsReserved', value: points, unit: 'Count' },
  ]);
  log('INFO', 'Job created', {
    jobId,
    userSub: session.sub,
    modelId: model.id,
    provider: model.provider,
    pointsReserved: points,
    outcome: 'queued',
  });
  return { status: 202, body: { jobId, status: 'queued', pointsReserved: points } };
}

/** Why the model can't take this request, in words for the user; undefined when it can. */
export function unsupportedOption(
  model: ModelConfig,
  request: GenerateJobRequest,
): string | undefined {
  const name = model.displayName;
  if (!model.capabilities.generate) return `${name} can't create new images. Pick another model.`;
  if (!model.qualities[request.quality]) {
    return `${name} doesn't offer ${request.quality} quality. Pick another quality.`;
  }
  if (!model.capabilities.aspects.includes(request.aspect)) {
    return `${name} doesn't support the ${request.aspect} aspect ratio. Pick another one.`;
  }
  if (request.transparentBackground && !model.capabilities.transparentBackground) {
    return `${name} can't make transparent backgrounds. Turn the option off or pick another model.`;
  }
  if (request.seed !== undefined && !model.capabilities.seed) {
    return `${name} doesn't support a fixed seed. Clear the seed or pick another model.`;
  }
  return undefined;
}

/** Why the model can't make this edit, in words for the user; undefined when it can (EDIT-4, EDIT-5). */
export function unsupportedEditOption(
  model: ModelConfig,
  request: EditJobRequest,
): string | undefined {
  const name = model.displayName;
  if (!model.capabilities.edit) return `${name} can't edit images. Pick another model.`;
  if (!model.qualities[request.quality]) {
    return `${name} doesn't offer ${request.quality} quality. Pick another quality.`;
  }
  const references = request.referenceKeys?.length ?? 0;
  const allowed = model.capabilities.referenceImages;
  if (references > allowed) {
    return allowed === 0
      ? `${name} doesn't take reference images. Remove them or pick another model.`
      : `${name} takes up to ${allowed} reference ${plural(allowed, 'image')}. Remove some or pick another model.`;
  }
  return undefined;
}

/** The fields of a `VER#` item an edit request is checked against. */
interface VersionDimensions {
  width: number;
  height: number;
  aspect?: Aspect;
}

async function readVersion(
  deps: JobsDeps,
  sub: string,
  imageId: string,
  version: number,
): Promise<VersionDimensions | undefined> {
  const result = await deps.client.send(
    new GetCommand({
      TableName: deps.tableName,
      Key: { PK: userPk(sub), SK: versionSk(imageId, version) },
    }),
  );
  return result.Item as VersionDimensions | undefined;
}

/**
 * Checks that the parent version and every reference image are the caller's own (EDIT-1, EDIT-5), and returns
 * the aspect the edit is made at: the parent's own when the model offers it, otherwise the nearest one it does.
 * Undefined when any of them is missing or someone else's, which the API answers with 404 so image IDs can't
 * be probed. A reference upload must still be in the bucket and at most 10 MB.
 */
async function editAspect(
  deps: JobsDeps,
  session: Session,
  request: EditJobRequest,
  model: ModelConfig,
): Promise<Aspect | undefined> {
  const parent = await readVersion(deps, session.sub, request.imageId, request.parentVersion);
  if (!parent) return undefined;
  for (const key of request.referenceKeys ?? []) {
    const reference = parseReferenceKey(key);
    if (!reference || reference.sub !== session.sub) return undefined;
    if (reference.kind === 'version') {
      if (!(await readVersion(deps, session.sub, reference.imageId, reference.version))) {
        return undefined;
      }
    } else {
      const size = await deps.objectSize(key);
      if (size === undefined || size > MAX_UPLOAD_BYTES) return undefined;
    }
  }
  const aspects = model.capabilities.aspects;
  if (parent.aspect && aspects.includes(parent.aspect)) return parent.aspect;
  return nearestAspect({ width: parent.width, height: parent.height }, aspects);
}

/**
 * Why the user can't create images or use the enhancer right now, or undefined when they can: a suspended or
 * deleting account, onboarding not done for the current terms (AUTH-4), or a cooldown after repeated blocks.
 */
export function profileRefusal(profile: Profile, now: Date): ApiResult | undefined {
  if (profile.status === 'suspended') {
    return apiError(
      'suspended',
      `Your account is suspended, so you can't create images. If you think this is a mistake, email ${CONTACT_EMAIL}.`,
    );
  }
  if (profile.status === 'deleting') {
    return apiError('account_deleting', 'Your account is being deleted.');
  }
  if (!onboardingComplete(profile)) {
    return apiError(
      'onboarding_required',
      profile.tosAcceptedAt
        ? 'Our terms have changed. Accept the new terms to keep creating images.'
        : 'Confirm your age and accept the terms before creating your first image.',
    );
  }
  if (inCooldown(profile, now) && profile.cooldownUntil) {
    // A cooldown lasts 24 hours, so the day matters as much as the time.
    const until = COOLDOWN_END_FORMAT.format(new Date(profile.cooldownUntil));
    return apiError(
      'cooldown',
      `Image creation is paused for your account until ${until} UTC after several blocked requests.`,
    );
  }
  return undefined;
}

async function outOfPoints(
  deps: JobsDeps,
  sub: string,
  date: string,
  points: number,
): Promise<ApiResult> {
  const profile = await readProfile(deps.client, deps.tableName, sub);
  const limit = dailyLimit(profile ?? {}, deps.defaultDailyPoints);
  const left = Math.max(0, limit - (await readUsedPoints(deps.client, deps.tableName, sub, date)));
  return apiError(
    'out_of_points',
    `This request needs ${points} ${plural(points, 'point')} and you have ${left} left today. Points reset at 00:00 UTC.`,
  );
}

/** The `GET /api/jobs/:id` body. */
export interface JobStatusBody {
  jobId: string;
  type: JobItem['type'];
  status: JobStatus;
  modelId: string;
  createdAt: string;
  pointsReserved: number;
  pointsCharged?: number;
  finishedAt?: string;
  /** Plain-language reason when the job failed or was blocked (GEN-10). */
  error?: string;
  /** The images once the job succeeded: presigned URLs to show each one and to download its original PNG. */
  images?: { imageId: string; version: number; url: string; downloadUrl: string }[];
}

/**
 * `GET /api/jobs/:id`: the job's status for its owner. Anyone else gets 404, the same as for a job that doesn't
 * exist, so job IDs can't be probed.
 */
export async function getJobStatus(
  deps: JobsDeps,
  session: Session,
  jobId: string,
): Promise<ApiResult> {
  const notFound = apiError('not_found', 'Job not found.');
  if (!ULID_PATTERN.test(jobId)) return notFound;
  const job = await readJob(deps.client, deps.tableName, jobId);
  if (!job || job.userId !== session.sub) return notFound;

  const body: JobStatusBody = {
    jobId: job.jobId,
    type: job.type,
    status: job.status,
    modelId: job.modelId,
    createdAt: job.createdAt,
    pointsReserved: job.pointsReserved,
    ...(job.pointsCharged !== undefined ? { pointsCharged: job.pointsCharged } : {}),
    ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
  };
  if ((job.status === 'failed' || job.status === 'blocked') && job.error) {
    body.error = job.error.message;
  }
  if (job.status === 'succeeded') {
    // Only the owner's own objects are ever presigned.
    const prefix = `users/${session.sub}/`;
    const images = (job.images ?? []).filter((image) => image.s3Key.startsWith(prefix));
    body.images = await Promise.all(
      images.map(async (image) => ({
        imageId: image.imageId,
        version: image.version,
        url: await deps.presign(image.s3Key),
        downloadUrl: await deps.presign(image.s3Key, imageFileName(image.imageId, image.version)),
      })),
    );
  }
  return { status: 200, body: { ...body } };
}

/** The file name a downloaded image is saved as, for example `pictora-01J…-v1.png`. */
export function imageFileName(imageId: string, version: number): string {
  return `pictora-${imageId}-v${version}.png`;
}

/** The `GET /api/me` body: the profile and today's points (LIM-1, LIM-2). */
export interface MeBody {
  sub: string;
  email: string;
  status: Profile['status'];
  /** The UTC day the points below are for. */
  date: string;
  dailyLimit: number;
  pointsUsed: number;
  pointsLeft: number;
  activeJobs: number;
  /** True until the user has accepted the current terms (AUTH-4); the UI sends them to `/onboarding`. */
  onboardingRequired: boolean;
  /** When the profile was created. */
  memberSince: string;
}

/** `GET /api/me`: creates the profile on first use, then reports today's points and running jobs. */
export async function getMe(deps: JobsDeps, session: Session): Promise<ApiResult> {
  const now = deps.now();
  const profile = await ensureProfile(deps.client, deps.tableName, session, now);
  const date = utcDate(now);
  const limit = dailyLimit(profile, deps.defaultDailyPoints);
  const used = await readUsedPoints(deps.client, deps.tableName, session.sub, date);
  const body: MeBody = {
    sub: session.sub,
    email: profile.email ?? session.email,
    status: profile.status,
    date,
    dailyLimit: limit,
    pointsUsed: used,
    pointsLeft: Math.max(0, limit - used),
    activeJobs: Math.max(0, profile.activeJobs),
    onboardingRequired: !onboardingComplete(profile),
    memberSince: profile.createdAt,
  };
  return { status: 200, body: { ...body } };
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

/** Logs an error as one JSON line through the app's Powertools logger, with the error's message. */
export function logError(message: string, fields: Record<string, unknown>): void {
  log('ERROR', message, fields);
}
