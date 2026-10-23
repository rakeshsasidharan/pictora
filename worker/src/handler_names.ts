/** Lambda handlers packaged in the worker container image. */
export const WORKER_HANDLERS = [
  'generate',
  'sweeper',
  'model_health',
  'purge',
  'success_metrics',
] as const;

export type WorkerHandler = (typeof WORKER_HANDLERS)[number];
