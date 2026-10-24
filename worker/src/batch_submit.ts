import { batchDeps } from './deps.js';
import { submitBatches, type BatchDeps, type BatchRunResult } from './batch.js';
import { log } from './log.js';

let deps: BatchDeps | undefined;

/**
 * The batch submitter (tech design 5.4), every 15 minutes from an EventBridge schedule. Throws when a job's turn
 * failed, so the run counts as an error; the next run tries those jobs again.
 */
export async function handler(): Promise<BatchRunResult> {
  deps ??= batchDeps();
  const result = await submitBatches(deps);
  log('INFO', 'Batch submission finished', {
    submitted: result.done.length,
    refunded: result.refunded.length,
    errors: result.errors.length,
    batches: result.batches,
  });
  if (result.errors.length > 0) {
    throw new Error(`${result.errors.length} batch jobs could not be submitted`);
  }
  return result;
}
