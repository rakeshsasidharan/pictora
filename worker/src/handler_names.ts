/** Lambda handlers packaged in the worker container image. */
export const WORKER_HANDLERS = ['generate', 'sweeper', 'model_health'] as const;

export type WorkerHandler = (typeof WORKER_HANDLERS)[number];
