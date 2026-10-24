import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import {
  BATCH_WINDOW_MS,
  MAX_BATCH_JOBS,
  PROVIDER_REFUSAL_CATEGORY,
  jobError,
  settleJobPoints,
  type BatchJobStatus,
  type GenerateJobRequest,
  type JobErrorCode,
  type JobItem,
  type ModelConfig,
} from '@pictora/core';
import { applyCooldown } from '@pictora/core/block-store';
import { recordGeneration } from '@pictora/core/metrics-store';
import {
  PROVIDER_TIMEOUT_MS,
  ProviderSafetyError,
  providerSignal,
  type BatchImageProvider,
  type BatchImageRequest,
  type BatchItem,
  type BatchItemResult,
  type ImageRequest,
} from '@pictora/providers';
import { ulid } from 'ulid';
import {
  AccountGoneError,
  claimBatchJob,
  completeJob,
  dropJob,
  findStuckJobs,
  refundJob,
  setBatchId,
  type BlockRecord,
  type StoredImage,
} from './job_store.js';
import { log } from './log.js';
import {
  buildImageRequest,
  errorCode,
  imageTitle,
  splitPoints,
  storeImage,
  type ModerationVerdict,
  type PipelineDeps,
} from './pipeline.js';
import { reportMonthlySpend } from './spend.js';

/**
 * A submitted job with no batch ID this long after submission was never accepted by the provider (the submitter
 * died between the provider call and recording the ID), so the poller refunds it.
 */
export const UNRECORDED_BATCH_MS = 60 * 60_000;

/** How long past the provider's window the poller waits for a batch to finish before refunding its jobs. */
export const BATCH_GRACE_MS = 60 * 60_000;

/** What the batch Lambdas need: the pipeline's dependencies, with batch adapters instead of single calls. */
export interface BatchDeps extends Omit<PipelineDeps, 'provider' | 'providerTimeoutMs'> {
  /** The batch adapter for a model (`createBatchProviderFactory`). */
  batchProvider: (model: ModelConfig) => BatchImageProvider;
}

/** What a submitter or poller run did, by job ID. */
export interface BatchRunResult {
  /** Jobs put in a provider batch (submitter) or recorded with their images (poller). */
  done: string[];
  /** Jobs failed or blocked with a refund, or dropped because their account is gone. */
  refunded: string[];
  /** Jobs whose turn threw; the next run tries them again. */
  errors: string[];
  /** Provider batch IDs created (submitter) or found still running (poller). */
  batches: string[];
}

/** A cutoff that takes in every job in a status, including one that entered it this very millisecond. */
function everythingBefore(now: Date): Date {
  return new Date(now.getTime() + 1);
}

function emptyResult(): BatchRunResult {
  return { done: [], refunded: [], errors: [], batches: [] };
}

function fieldsOf(job: JobItem): Record<string, unknown> {
  return {
    jobId: job.jobId,
    userSub: job.userId,
    modelId: job.modelId,
    provider: job.provider,
    batchId: job.batchId,
  };
}

/** A batch job's request: batch jobs are always generate jobs (the schema allows `delivery` on those only). */
function generateRequest(job: JobItem): GenerateJobRequest | undefined {
  return job.request.type === 'generate' ? job.request : undefined;
}

/** The provider request for a batch job: the worker's own request, without the abort signal. */
function batchRequest(request: GenerateJobRequest, model: ModelConfig): BatchImageRequest {
  const built: Partial<ImageRequest> = buildImageRequest(
    request,
    model,
    new AbortController().signal,
  );
  delete built.signal;
  return built as BatchImageRequest;
}

/** Groups jobs by a key, keeping the order of the first job of each group. */
function groupBy(jobs: readonly JobItem[], key: (job: JobItem) => string): Map<string, JobItem[]> {
  const groups = new Map<string, JobItem[]>();
  for (const job of jobs) {
    const group = groups.get(key(job)) ?? [];
    group.push(job);
    groups.set(key(job), group);
  }
  return groups;
}

/**
 * Fails or blocks a batch job with a full refund, from the status it was read in. A job whose account is gone
 * is dropped instead. Returns false when the job had already moved on.
 */
async function refundBatchJob(
  deps: BatchDeps,
  job: JobItem,
  from: BatchJobStatus,
  code: JobErrorCode,
  block?: Omit<BlockRecord, 'blockId'>,
): Promise<boolean> {
  const now = deps.now();
  const status = code === 'blocked' ? 'blocked' : 'failed';
  let done: boolean;
  try {
    done = await refundJob(deps, {
      job,
      from,
      status,
      error: jobError(code),
      ...(block ? { block: { ...block, blockId: ulid(now.getTime()) } } : {}),
      now,
    });
  } catch (error) {
    if (!(error instanceof AccountGoneError)) throw error;
    log('INFO', 'Account gone; dropping the batch job', fieldsOf(job));
    return dropJob(deps, job, jobError(code), now);
  }
  if (done) {
    deps.metrics?.([
      { name: status === 'blocked' ? 'JobsBlocked' : 'JobsFailed', value: 1, unit: 'Count' },
    ]);
    log('INFO', 'Batch job refunded', { ...fieldsOf(job), outcome: status, code });
    // As in the worker, a third block in 24 hours cools the account down.
    if (block) {
      try {
        const until = await applyCooldown(deps, job.userId, now);
        if (until)
          log('INFO', 'Account cooled down after repeated blocks', { ...fieldsOf(job), until });
      } catch (error) {
        log('ERROR', 'Cooldown check failed', { ...fieldsOf(job), error });
      }
    }
  }
  return done;
}

/**
 * The batch submitter (tech design 5.4), every 15 minutes: collects the scheduled batch jobs, oldest first, and
 * sends them to their provider's batch API, one batch per model of at most 200 jobs. Each job is moderated
 * first, as the worker would before a paid call; a flagged one is blocked and refunded, and a moderation
 * outage leaves the job for the next run. Jobs are claimed (`scheduled → submitted`) before the provider call,
 * so none is ever sent twice; if the call fails they are refunded. Jobs scheduled for longer than the 24-hour
 * window, or for a model that is switched off or takes no batches, are refunded.
 */
export async function submitBatches(deps: BatchDeps): Promise<BatchRunResult> {
  const result = emptyResult();
  const now = deps.now();
  const scheduled = await findStuckJobs(deps, 'scheduled', everythingBefore(now));
  if (scheduled.length === 0) return result;
  const models = await deps.models();

  for (const [modelId, jobs] of groupBy(scheduled, (job) => job.modelId)) {
    const model = models.find((candidate) => candidate.id === modelId);
    const usable = model?.enabled && model.capabilities.batch && model.capabilities.generate;
    const ready: { job: JobItem; item: BatchItem }[] = [];
    for (const job of jobs) {
      const request = generateRequest(job);
      try {
        if (now.getTime() - Date.parse(job.createdAt) >= BATCH_WINDOW_MS) {
          log('WARN', 'Batch job never submitted within the window', fieldsOf(job));
          if (await refundBatchJob(deps, job, 'scheduled', 'batch_expired'))
            result.refunded.push(job.jobId);
          continue;
        }
        if (!model || !usable || !request) {
          log('WARN', 'Batch job model unknown, switched off or without batches', fieldsOf(job));
          if (await refundBatchJob(deps, job, 'scheduled', 'provider_error'))
            result.refunded.push(job.jobId);
          continue;
        }
        if (ready.length >= MAX_BATCH_JOBS) continue;
        const verdict = await moderate(deps, job, model, request);
        if (verdict === 'error') {
          result.errors.push(job.jobId);
          continue;
        }
        if (verdict.flagged) {
          const block = {
            stage: verdict.stage ?? 'prompt',
            category: verdict.category,
            prompt: buildImageRequest(request, model, new AbortController().signal).prompt,
          } as const;
          if (await refundBatchJob(deps, job, 'scheduled', 'blocked', block)) {
            result.refunded.push(job.jobId);
          }
          continue;
        }
        const claimed = await claimBatchJob(deps, job, deps.now());
        if (claimed)
          ready.push({
            job: claimed,
            item: { key: job.jobId, request: batchRequest(request, model) },
          });
      } catch (error) {
        log('ERROR', 'Preparing a batch job failed', { ...fieldsOf(job), error });
        result.errors.push(job.jobId);
      }
    }
    if (!model || ready.length === 0) continue;

    let batchId: string;
    try {
      batchId = await deps.batchProvider(model).submitBatch(
        model,
        ready.map(({ item }) => item),
        providerSignal(undefined, PROVIDER_TIMEOUT_MS),
      );
    } catch (error) {
      log('ERROR', 'Submitting a provider batch failed; refunding its jobs', {
        modelId,
        jobs: ready.length,
        error,
      });
      for (const { job } of ready) {
        try {
          if (await refundBatchJob(deps, job, 'submitted', 'provider_error'))
            result.refunded.push(job.jobId);
        } catch (refundError) {
          log('ERROR', 'Refund after a failed batch submission failed', {
            ...fieldsOf(job),
            error: refundError,
          });
          result.errors.push(job.jobId);
        }
      }
      continue;
    }
    result.batches.push(batchId);
    for (const { job } of ready) {
      try {
        await setBatchId(deps, job, batchId);
        result.done.push(job.jobId);
      } catch (error) {
        // The poller refunds a submitted job that never got its batch ID.
        log('ERROR', 'Recording the batch ID failed', { ...fieldsOf(job), batchId, error });
        result.errors.push(job.jobId);
      }
    }
    log('INFO', 'Provider batch submitted', { modelId, batchId, jobs: ready.length });
  }
  return result;
}

/** Moderates a batch job's final prompt, as the worker does; `error` when the moderation service failed. */
async function moderate(
  deps: BatchDeps,
  job: JobItem,
  model: ModelConfig,
  request: GenerateJobRequest,
): Promise<ModerationVerdict | 'error'> {
  if (!deps.moderate) return { flagged: false };
  try {
    return await deps.moderate({
      job,
      model,
      request: buildImageRequest(request, model, new AbortController().signal),
    });
  } catch (error) {
    log('ERROR', 'Moderation failed; leaving the batch job for the next run', {
      ...fieldsOf(job),
      error,
    });
    return 'error';
  }
}

/**
 * The batch poller (tech design 5.4), every 15 minutes: reads each provider batch that submitted jobs are in.
 * Once a batch is done, each job's images are stored and recorded, with points settled as the worker settles
 * them (only the images that came back are charged, at the batch price), and a job with none is refunded:
 * blocked for a safety refusal, failed otherwise. A failed batch refunds all its jobs. A batch still running
 * past the 24-hour window and an hour's grace refunds its jobs, as does a job that never got a batch ID.
 * Re-polling is safe: finished jobs leave the submitted index, and every record is guarded on the job's status.
 */
export async function pollBatches(deps: BatchDeps): Promise<BatchRunResult> {
  const result = emptyResult();
  const now = deps.now();
  const submitted = await findStuckJobs(deps, 'submitted', everythingBefore(now));
  if (submitted.length === 0) return result;
  const models = await deps.models();

  const unrecorded = submitted.filter((job) => !job.batchId);
  for (const job of unrecorded) {
    if (now.getTime() - Date.parse(job.submittedAt ?? job.createdAt) < UNRECORDED_BATCH_MS)
      continue;
    await settleTurn(result, job, async () => {
      log('WARN', 'Submitted batch job never got a batch ID', fieldsOf(job));
      return (await refundBatchJob(deps, job, 'submitted', 'provider_error'))
        ? 'refunded'
        : 'skipped';
    });
  }

  const recorded = submitted.filter((job) => job.batchId);
  for (const [batchId, jobs] of groupBy(recorded, (job) => job.batchId!)) {
    const first = jobs[0]!;
    const model = models.find((candidate) => candidate.id === first.modelId);
    const items = model
      ? jobs.flatMap((job) => {
          const request = generateRequest(job);
          return request ? [{ key: job.jobId, request: batchRequest(request, model) }] : [];
        })
      : [];
    const overdue = jobs.filter(
      (job) => now.getTime() - Date.parse(job.createdAt) >= BATCH_WINDOW_MS + BATCH_GRACE_MS,
    );

    let poll: Awaited<ReturnType<BatchImageProvider['pollBatch']>>;
    try {
      if (!model) throw new Error(`Model ${first.modelId} is not in the registry`);
      poll = await deps
        .batchProvider(model)
        .pollBatch(model, batchId, items, providerSignal(undefined, PROVIDER_TIMEOUT_MS));
    } catch (error) {
      log('ERROR', 'Reading a provider batch failed', { batchId, modelId: first.modelId, error });
      for (const job of jobs) {
        if (overdue.includes(job)) {
          await settleTurn(result, job, async () =>
            (await refundBatchJob(deps, job, 'submitted', 'batch_expired'))
              ? 'refunded'
              : 'skipped',
          );
        } else {
          result.errors.push(job.jobId);
        }
      }
      continue;
    }

    if (poll.state === 'pending') {
      result.batches.push(batchId);
      for (const job of overdue) {
        await settleTurn(result, job, async () => {
          log('WARN', 'Batch still running past its window', fieldsOf(job));
          return (await refundBatchJob(deps, job, 'submitted', 'batch_expired'))
            ? 'refunded'
            : 'skipped';
        });
      }
      continue;
    }
    if (poll.state === 'failed') {
      log('ERROR', 'Provider batch failed', { batchId, modelId: first.modelId, error: poll.error });
      for (const job of jobs) {
        await settleTurn(result, job, async () =>
          (await refundBatchJob(deps, job, 'submitted', 'provider_error')) ? 'refunded' : 'skipped',
        );
      }
      continue;
    }
    for (const job of jobs) {
      const outcome = poll.results.get(job.jobId);
      await settleTurn(result, job, () => finishBatchJob(deps, job, model!, outcome, poll.expired));
    }
    log('INFO', 'Provider batch read', {
      batchId,
      modelId: first.modelId,
      jobs: jobs.length,
      expired: poll.expired,
    });
  }
  return result;
}

/** Runs one job's turn and files its outcome; a throw counts as an error for the next run to retry. */
async function settleTurn(
  result: BatchRunResult,
  job: JobItem,
  run: () => Promise<'done' | 'refunded' | 'skipped'>,
): Promise<void> {
  try {
    const outcome = await run();
    if (outcome === 'done') result.done.push(job.jobId);
    if (outcome === 'refunded') result.refunded.push(job.jobId);
  } catch (error) {
    log('ERROR', 'Finishing a batch job failed', { ...fieldsOf(job), error });
    result.errors.push(job.jobId);
  }
}

/**
 * Records one job of a finished batch: its images stored and the job succeeded with its points settled, or a
 * refund when the batch has nothing for it. A job whose account was deleted meanwhile is dropped, and its
 * stored images removed again.
 */
async function finishBatchJob(
  deps: BatchDeps,
  job: JobItem,
  model: ModelConfig,
  outcome: BatchItemResult | undefined,
  expired: boolean,
): Promise<'done' | 'refunded' | 'skipped'> {
  const request = generateRequest(job);
  const images = outcome?.images.slice(0, request?.count ?? 0) ?? [];
  if (!request || images.length === 0) {
    const error = outcome?.error;
    const code: JobErrorCode =
      error instanceof ProviderSafetyError
        ? 'blocked'
        : !outcome || expired
          ? 'batch_expired'
          : errorCode(error);
    log(code === 'blocked' ? 'INFO' : 'WARN', 'Batch job made no images', {
      ...fieldsOf(job),
      code,
      error,
    });
    const sent = request
      ? buildImageRequest(request, model, new AbortController().signal).prompt
      : '';
    const block =
      code === 'blocked'
        ? ({ stage: 'provider', category: PROVIDER_REFUSAL_CATEGORY, prompt: sent } as const)
        : undefined;
    return (await refundBatchJob(deps, job, 'submitted', code, block)) ? 'refunded' : 'skipped';
  }

  const providerCostCents = outcome?.providerCostCents ?? 0;
  const settlement = settleJobPoints(
    job.pointsReserved,
    request.count,
    images.length,
    providerCostCents,
  );
  const shares = splitPoints(settlement.chargedPoints, images.length);
  const stored: StoredImage[] = await Promise.all(
    images.map((image, index) =>
      storeImage(deps, job.userId, deps.newImageId(), 1, image, shares[index] ?? 0),
    ),
  );
  const now = deps.now();
  let completed: boolean;
  try {
    completed = await completeJob(deps, {
      job,
      request,
      images: stored,
      settlement,
      providerCostCents,
      sentPrompt: buildImageRequest(request, model, new AbortController().signal).prompt,
      title: imageTitle(request.prompt),
      now,
    });
  } catch (error) {
    if (!(error instanceof AccountGoneError)) throw error;
    log('INFO', 'Account gone; dropping the batch job and its images', fieldsOf(job));
    await removeStored(deps, stored);
    return (await dropJob(deps, job, jobError('provider_error'), now)) ? 'refunded' : 'skipped';
  }
  if (!completed) {
    log('WARN', 'Batch job moved on before it could be recorded', fieldsOf(job));
    await removeStored(deps, stored);
    return 'skipped';
  }
  deps.metrics?.([
    { name: 'JobsSucceeded', value: 1, unit: 'Count' },
    { name: 'ProviderCostCents', value: providerCostCents, unit: 'Count' },
  ]);
  if (deps.spend && providerCostCents > 0) await reportMonthlySpend(deps, deps.spend, now);
  try {
    await recordGeneration(deps, job.userId, job.createdAt, now);
  } catch (error) {
    log('ERROR', 'Recording the success metrics failed', { ...fieldsOf(job), error });
  }
  log('INFO', 'Batch job succeeded', {
    ...fieldsOf(job),
    outcome: 'succeeded',
    images: images.length,
    requested: request.count,
    pointsCharged: settlement.chargedPoints,
    costCents: providerCostCents,
  });
  return 'done';
}

/** Deletes the objects of images that were stored but not recorded. */
async function removeStored(deps: BatchDeps, stored: readonly StoredImage[]): Promise<void> {
  await Promise.all(
    stored.flatMap((image) =>
      [image.s3Key, image.thumbKey].map((key) =>
        deps.s3.send(new DeleteObjectCommand({ Bucket: deps.bucket, Key: key })),
      ),
    ),
  );
}
