import { batchDeps } from './deps.js';
import { pollBatches, type BatchDeps, type BatchRunResult } from './batch.js';
import { log } from './log.js';

let deps: BatchDeps | undefined;

/**
 * The batch poller (tech design 5.4), every 15 minutes from an EventBridge schedule. Throws when a job's turn
 * failed, so the run counts as an error; the next run reads those batches again.
 */
export async function handler(): Promise<BatchRunResult> {
  deps ??= batchDeps();
  const result = await pollBatches(deps);
  log('INFO', 'Batch poll finished', {
    recorded: result.done.length,
    refunded: result.refunded.length,
    errors: result.errors.length,
    pending: result.batches,
  });
  if (result.errors.length > 0) {
    throw new Error(`${result.errors.length} batch jobs could not be finished`);
  }
  return result;
}
