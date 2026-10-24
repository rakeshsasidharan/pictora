/** Lambda handlers packaged in the worker container image. */
export const WORKER_HANDLERS = [
  'generate',
  'sweeper',
  'model_health',
  'purge',
  'success_metrics',
  'batch_submit',
  'batch_poll',
] as const;

export type WorkerHandler = (typeof WORKER_HANDLERS)[number];
