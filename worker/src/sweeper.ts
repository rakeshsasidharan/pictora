import {
  STUCK_QUEUED_MS,
  STUCK_RUNNING_MS,
  jobError,
  type ActiveJobStatus,
  type BatchJobStatus,
} from '@pictora/core';
import { powertoolsMetrics, type EmitMetrics } from '@pictora/core/observability';
import { tableContext } from './deps.js';
import { findStuckJobs, refundJob, type TableContext } from './job_store.js';
import { log } from './log.js';

export interface SweepDeps extends TableContext {
  now: () => Date;
  /** Publishes `JobsFailed` for each swept job when set. */
  metrics?: EmitMetrics;
}

export interface SweepResult {
  /** Jobs failed and refunded. */
  swept: string[];
  /** Jobs that moved on between the query and the refund, so were left alone. */
  skipped: string[];
  /** Jobs whose refund threw; the next run tries them again. */
  errors: string[];
}

/** How long a job may stay in each active status before the sweeper fails it; batch jobs have their own limits. */
const STUCK_AFTER_MS: Readonly<Record<Exclude<ActiveJobStatus, BatchJobStatus>, number>> = {
  running: STUCK_RUNNING_MS,
  queued: STUCK_QUEUED_MS,
};

/**
 * Fails and refunds stuck jobs (tech design 3.2): running for over 5 minutes (the worker died mid-flight) or
 * queued for over 10 (the message was lost or dead-lettered). A swept job is never sent to the provider again:
 * the worker only runs queued jobs, and the refund is guarded on the status the job was found in.
 */
export async function sweepStuckJobs(deps: SweepDeps): Promise<SweepResult> {
  const result: SweepResult = { swept: [], skipped: [], errors: [] };
  const now = deps.now();
  for (const status of ['running', 'queued'] as const) {
    const cutoff = new Date(now.getTime() - STUCK_AFTER_MS[status]);
    for (const job of await findStuckJobs(deps, status, cutoff)) {
      const fields = {
        jobId: job.jobId,
        userSub: job.userId,
        modelId: job.modelId,
        provider: job.provider,
        status,
        since: job.GSI1SK,
      };
      try {
        const done = await refundJob(deps, {
          job,
          from: status,
          status: 'failed',
          error: jobError('stuck'),
          now: deps.now(),
        });
        (done ? result.swept : result.skipped).push(job.jobId);
        if (done) deps.metrics?.([{ name: 'JobsFailed', value: 1, unit: 'Count' }]);
        log(
          done ? 'WARN' : 'INFO',
          done ? 'Stuck job failed and refunded' : 'Job moved on',
          fields,
        );
      } catch (error) {
        result.errors.push(job.jobId);
        log('ERROR', 'Sweeping a stuck job failed', { ...fields, error });
      }
    }
  }
  return result;
}

let deps: SweepDeps | undefined;

/** Runs every 5 minutes from an EventBridge schedule. Throws when a refund failed, so the run counts as an error. */
export async function handler(): Promise<SweepResult> {
  deps ??= { ...tableContext(), now: () => new Date(), metrics: powertoolsMetrics() };
  const result = await sweepStuckJobs(deps);
  log('INFO', 'Sweep finished', {
    swept: result.swept.length,
    skipped: result.skipped.length,
    errors: result.errors.length,
  });
  if (result.errors.length > 0) {
    throw new Error(`${result.errors.length} stuck jobs could not be refunded`);
  }
  return result;
}
