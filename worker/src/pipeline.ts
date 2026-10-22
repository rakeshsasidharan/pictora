import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import {
  PROVIDER_REFUSAL_CATEGORY,
  applyStyle,
  imageKey,
  jobError,
  settleJobPoints,
  thumbnailKey,
  type Aspect,
  type BlockStage,
  type EditJobRequest,
  type GenerateJobRequest,
  type JobErrorCode,
  type JobItem,
  type ModelConfig,
} from '@pictora/core';
import {
  normalisePng,
  PROVIDER_TIMEOUT_MS,
  ProviderSafetyError,
  ProviderTimeoutError,
  providerSignal,
  thumbnail,
  type ImageProvider,
  type ImageRequest,
  type ImageResult,
} from '@pictora/providers';
import type { EmitMetrics, MetricPoint } from '@pictora/core/observability';
import { applyCooldown } from '@pictora/core/block-store';
import { recordGeneration } from '@pictora/core/metrics-store';
import { ulid } from 'ulid';
import { EditSourceError, loadEditInputs, type EditInputs } from './edit.js';
import {
  claimJob,
  claimVersion,
  completeEditJob,
  completeJob,
  loadJob,
  refundJob,
  type BlockRecord,
  type StoredImage,
  type TableContext,
} from './job_store.js';
import { log } from './log.js';
import { reportMonthlySpend, type SpendReporting } from './spend.js';

/**
 * What the moderation hook decides about a request before it reaches the provider: allowed, or blocked with
 * the policy category and whether the prompt or an input image was flagged (the prompt when not given).
 */
export type ModerationVerdict =
  { flagged: false } | { flagged: true; category: string; stage?: Exclude<BlockStage, 'provider'> };

/** The moderation hook: checks the final prompt (and any input image) before the paid provider call. */
export type ModerateRequest = (input: {
  job: JobItem;
  model: ModelConfig;
  request: ImageRequest;
}) => Promise<ModerationVerdict>;

/** What the pipeline needs, so tests can swap DynamoDB, S3, the providers and the clock. */
export interface PipelineDeps extends TableContext {
  s3: S3Client;
  bucket: string;
  /** The environment's registry, switched-off models included. */
  models: () => Promise<ModelConfig[]>;
  /** The adapter for a model, with retries and typed errors (`createProviderFactory`). */
  provider: (model: ModelConfig) => ImageProvider;
  /** Runs before every provider call when set; a flagged request is blocked and refunded. */
  moderate?: ModerateRequest;
  /** How long the provider gets, retry included; 120 s unless a test shortens it. */
  providerTimeoutMs?: number;
  /** Publishes the job metrics (tech design 11) when set. */
  metrics?: EmitMetrics;
  /** When set, the month's platform spend is published after each job with a provider cost. */
  spend?: SpendReporting;
  now: () => Date;
  newImageId: () => string;
}

/** What happened to a job message. `skipped` means the job wasn't queued, so nothing was done. */
export type JobOutcome = 'succeeded' | 'failed' | 'blocked' | 'skipped';

/** The longest image title, taken from the start of the prompt. */
export const MAX_TITLE_LENGTH = 80;

/**
 * Runs one generate or edit job (tech design 5.1, 5.3): claims it exactly once, calls the provider with a 120 s
 * deadline, stores each image as a PNG and a WebP thumbnail, and records the result with the points settled. An
 * edit loads its parent version and references first, and its result becomes the image's next version. A failed,
 * timed-out or refused call fails or blocks the job with a full refund. A job that isn't queued (a redelivered
 * message, or a job the sweeper already failed) is acknowledged without touching the provider.
 */
export async function processJob(deps: PipelineDeps, jobId: string): Promise<JobOutcome> {
  const loaded = await loadJob(deps, jobId);
  if (!loaded) {
    log('WARN', 'Job not found; acknowledging the message', { jobId });
    return 'skipped';
  }
  if (loaded.status !== 'queued') {
    log('INFO', 'Job already picked up; acknowledging the message', {
      jobId,
      status: loaded.status,
    });
    return 'skipped';
  }
  const job = await claimJob(deps, jobId, deps.now());
  if (!job) {
    log('INFO', 'Job claimed by another delivery; acknowledging the message', { jobId });
    return 'skipped';
  }
  const fields = { jobId, userSub: job.userId, modelId: job.modelId, provider: job.provider };

  let model: ModelConfig | undefined;
  try {
    model = (await deps.models()).find((candidate) => candidate.id === job.modelId);
  } catch (error) {
    log('ERROR', 'Model registry unavailable', { ...fields, error });
    return fail(deps, job, 'provider_error');
  }
  if (!model?.enabled) {
    log('WARN', 'Model unknown or switched off since the job was queued', fields);
    return fail(deps, job, 'provider_error');
  }

  const signal = providerSignal(undefined, deps.providerTimeoutMs ?? PROVIDER_TIMEOUT_MS);
  const request = job.request;
  let imageRequest: ImageRequest;
  let edit: EditInputs | undefined;
  if (request.type === 'edit') {
    try {
      edit = await loadEditInputs(deps, job.userId, request, model);
    } catch (error) {
      const missing = error instanceof EditSourceError;
      log(missing ? 'WARN' : 'ERROR', 'Edit inputs could not be loaded', { ...fields, error });
      return fail(deps, job, missing ? 'source_missing' : 'provider_error');
    }
    imageRequest = buildEditRequest(request, edit, signal);
  } else {
    imageRequest = buildImageRequest(request, model, signal);
  }

  if (deps.moderate) {
    let verdict: ModerationVerdict;
    try {
      verdict = await deps.moderate({ job, model, request: imageRequest });
    } catch (error) {
      // Never proceed unchecked: a moderation outage fails the job.
      log('ERROR', 'Moderation failed', { ...fields, error });
      return fail(deps, job, 'provider_error');
    }
    if (verdict.flagged) {
      const stage = verdict.stage ?? 'prompt';
      log('INFO', 'Request blocked by moderation', {
        ...fields,
        stage,
        category: verdict.category,
      });
      return fail(deps, job, 'blocked', {
        block: { stage, category: verdict.category, prompt: imageRequest.prompt },
      });
    }
  }

  const started = Date.now();
  let result: ImageResult;
  try {
    const adapter = deps.provider(model);
    result = edit
      ? await adapter.edit(model, imageRequest)
      : await adapter.generate(model, imageRequest);
  } catch (error) {
    const code = errorCode(error);
    const latencyMs = Date.now() - started;
    deps.metrics?.([providerLatency(job, latencyMs)]);
    log(code === 'blocked' ? 'INFO' : 'ERROR', 'Provider call failed', {
      ...fields,
      outcome: code,
      latencyMs,
      error,
    });
    return fail(deps, job, code, {
      ...(code === 'blocked'
        ? {
            block: {
              stage: 'provider',
              category: PROVIDER_REFUSAL_CATEGORY,
              prompt: imageRequest.prompt,
            },
          }
        : {}),
    });
  }
  const latencyMs = Date.now() - started;
  deps.metrics?.([providerLatency(job, latencyMs)]);
  const providerCostCents = result.providerCostCents;
  const images = result.images.slice(0, imageRequest.count);
  if (images.length === 0) {
    log('ERROR', 'Provider returned no images', { ...fields, providerCostCents });
    return fail(deps, job, 'provider_error', { providerCostCents });
  }

  const settlement = settleJobPoints(
    job.pointsReserved,
    imageRequest.count,
    images.length,
    providerCostCents,
  );
  let recorded: 'completed' | 'swept' | 'image_gone';
  try {
    if (request.type === 'edit') {
      const [image] = images;
      // An edit always has its inputs and at least one image here; the checks only narrow the types.
      recorded =
        edit && image
          ? await recordEdit(deps, job, request, edit.aspect, image, {
              settlement,
              providerCostCents,
            })
          : 'image_gone';
    } else {
      const shares = splitPoints(settlement.chargedPoints, images.length);
      const stored = await Promise.all(
        images.map((image, index) =>
          storeImage(deps, job.userId, deps.newImageId(), 1, image, shares[index] ?? 0),
        ),
      );
      const completed = await completeJob(deps, {
        job,
        request,
        images: stored,
        settlement,
        providerCostCents,
        sentPrompt: imageRequest.prompt,
        title: imageTitle(request.prompt),
        now: deps.now(),
      });
      recorded = completed ? 'completed' : 'swept';
    }
  } catch (error) {
    log('ERROR', 'Storing the result failed', { ...fields, error });
    return fail(deps, job, 'provider_error', { providerCostCents });
  }
  if (recorded === 'image_gone') {
    log('WARN', 'Image deleted while its edit ran', fields);
    return fail(deps, job, 'source_missing', { providerCostCents });
  }
  if (recorded === 'swept') {
    log('WARN', 'Job was failed by the sweeper before it could be recorded', fields);
    return 'skipped';
  }
  deps.metrics?.([
    { name: 'JobsSucceeded', value: 1, unit: 'Count' },
    { name: 'ProviderCostCents', value: providerCostCents, unit: 'Count' },
  ]);
  if (deps.spend && providerCostCents > 0) await reportMonthlySpend(deps, deps.spend, deps.now());
  await recordSuccessMetrics(deps, job, fields);
  log('INFO', 'Job succeeded', {
    ...fields,
    outcome: 'succeeded',
    images: images.length,
    requested: imageRequest.count,
    pointsCharged: settlement.chargedPoints,
    costCents: providerCostCents,
    latencyMs,
  });
  return 'succeeded';
}

/**
 * Records the success metrics that depend on the user (tech design 11.1): active today, and a first-session or
 * returning generation. The job's own counts were written with its final status. A failure here is logged, never
 * thrown: the job has already succeeded.
 */
async function recordSuccessMetrics(
  deps: PipelineDeps,
  job: JobItem,
  fields: Record<string, unknown>,
): Promise<void> {
  try {
    await recordGeneration(deps, job.userId, job.createdAt, deps.now());
  } catch (error) {
    log('ERROR', 'Recording the success metrics failed', { ...fields, error });
  }
}

/**
 * Stores an edit's result as the image's next version (EDIT-3): claims the version number, writes
 * `v<n>.png` and its thumbnail, and records the version with its parent and instruction.
 */
async function recordEdit(
  deps: PipelineDeps,
  job: JobItem,
  request: EditJobRequest,
  aspect: Aspect,
  image: ImageResult['images'][number],
  charge: { settlement: ReturnType<typeof settleJobPoints>; providerCostCents: number },
): Promise<'completed' | 'swept' | 'image_gone'> {
  const version = await claimVersion(deps, job.userId, request.imageId);
  if (version === undefined) return 'image_gone';
  const stored = await storeImage(
    deps,
    job.userId,
    request.imageId,
    version,
    image,
    charge.settlement.chargedPoints,
  );
  return completeEditJob(deps, {
    job,
    request,
    image: { ...stored, version },
    aspect,
    settlement: charge.settlement,
    providerCostCents: charge.providerCostCents,
    now: deps.now(),
  });
}

/** The provider's latency, with the provider as a dimension so the dashboard can split it. */
function providerLatency(job: JobItem, latencyMs: number): MetricPoint {
  return {
    name: 'ProviderLatencyMs',
    value: latencyMs,
    unit: 'Milliseconds',
    dimensions: { provider: job.provider },
  };
}

/**
 * The provider request for a generate job: the final prompt (the enhanced one when there is one) with the
 * style text added, the avoid text as a negative prompt where the model takes one, and the job's options.
 */
export function buildImageRequest(
  request: GenerateJobRequest,
  model: ModelConfig,
  signal: AbortSignal,
): ImageRequest {
  const avoid = request.avoid?.trim();
  return {
    prompt: applyStyle(request.enhancedPrompt ?? request.prompt, request.style),
    ...(avoid && model.capabilities.negativePrompt ? { negativePrompt: avoid } : {}),
    aspect: request.aspect,
    quality: request.quality,
    count: request.count,
    ...(request.seed !== undefined ? { seed: request.seed } : {}),
    ...(request.transparentBackground ? { transparentBackground: true } : {}),
    signal,
  };
}

/**
 * The provider request for an edit (tech design 5.3): the instruction as the prompt, the parent version's PNG as
 * the input image, the references after it, and one image at the aspect nearest the parent's shape. Edits are
 * stateless, so nothing else from earlier versions is sent.
 */
export function buildEditRequest(
  request: EditJobRequest,
  inputs: EditInputs,
  signal: AbortSignal,
): ImageRequest {
  return {
    prompt: request.instruction,
    aspect: inputs.aspect,
    quality: request.quality,
    count: 1,
    inputImage: inputs.parent,
    ...(inputs.references.length > 0 ? { referenceImages: inputs.references } : {}),
    signal,
  };
}

/** The job error for a provider failure: a safety refusal blocks the job, a timeout and anything else fail it. */
export function errorCode(error: unknown): JobErrorCode {
  if (error instanceof ProviderSafetyError) return 'blocked';
  if (error instanceof ProviderTimeoutError) return 'timeout';
  return 'provider_error';
}

/** A gallery title from the user's own prompt, cut at a word boundary. */
export function imageTitle(prompt: string): string {
  const text = prompt.replace(/\s+/g, ' ').trim();
  if (text.length <= MAX_TITLE_LENGTH) return text;
  const cut = text.slice(0, MAX_TITLE_LENGTH - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > MAX_TITLE_LENGTH / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Splits whole points across images as evenly as possible, the remainder going to the first ones. */
export function splitPoints(points: number, count: number): number[] {
  const base = Math.floor(points / count);
  const remainder = points - base * count;
  return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0));
}

/** Writes version `version` of an image to S3 as a PNG and a WebP thumbnail. */
async function storeImage(
  deps: PipelineDeps,
  sub: string,
  imageId: string,
  version: number,
  image: ImageResult['images'][number],
  costPoints: number,
): Promise<StoredImage> {
  const png = await normalisePng(image.png);
  const thumb = await thumbnail(png.png);
  const s3Key = imageKey(sub, imageId, version);
  const thumbKey = thumbnailKey(sub, imageId, version);
  await Promise.all([
    deps.s3.send(
      new PutObjectCommand({
        Bucket: deps.bucket,
        Key: s3Key,
        Body: png.png,
        ContentType: 'image/png',
      }),
    ),
    deps.s3.send(
      new PutObjectCommand({
        Bucket: deps.bucket,
        Key: thumbKey,
        Body: thumb.webp,
        ContentType: 'image/webp',
      }),
    ),
  ]);
  return {
    imageId,
    s3Key,
    thumbKey,
    width: png.width,
    height: png.height,
    ...(image.seed !== undefined ? { seed: image.seed } : {}),
    costPoints,
  };
}

/**
 * Fails (or, for a block, blocks) the running job with a full refund. A block also writes its `BLOCK#` item
 * and `MODLOG#` entry, then cools the account down if it was the third block in 24 hours.
 */
async function fail(
  deps: PipelineDeps,
  job: JobItem,
  code: JobErrorCode,
  options: { providerCostCents?: number; block?: Omit<BlockRecord, 'blockId'> } = {},
): Promise<JobOutcome> {
  const status = code === 'blocked' ? 'blocked' : 'failed';
  const now = deps.now();
  const done = await refundJob(deps, {
    job,
    from: 'running',
    status,
    error: jobError(code),
    providerCostCents: options.providerCostCents ?? 0,
    ...(options.block ? { block: { ...options.block, blockId: ulid(now.getTime()) } } : {}),
    now,
  });
  if (!done) {
    log('WARN', 'Job was failed by the sweeper first', { jobId: job.jobId });
    return 'skipped';
  }
  const costCents = options.providerCostCents ?? 0;
  deps.metrics?.([
    { name: status === 'blocked' ? 'JobsBlocked' : 'JobsFailed', value: 1, unit: 'Count' },
    ...(costCents > 0
      ? [{ name: 'ProviderCostCents' as const, value: costCents, unit: 'Count' as const }]
      : []),
  ]);
  log('INFO', 'Job refunded', {
    jobId: job.jobId,
    userSub: job.userId,
    modelId: job.modelId,
    provider: job.provider,
    outcome: status,
    code,
    costCents,
  });
  if (deps.spend && costCents > 0) await reportMonthlySpend(deps, deps.spend, now);
  if (options.block) {
    try {
      const until = await applyCooldown(deps, job.userId, now);
      if (until)
        log('INFO', 'Account cooled down after repeated blocks', { jobId: job.jobId, until });
    } catch (error) {
      log('ERROR', 'Cooldown check failed', { jobId: job.jobId, error });
    }
  }
  return status;
}
