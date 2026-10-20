import { createLog } from '@pictora/core/observability';

/**
 * Writes one JSON log line through Powertools Logger (tech design 11). Prompts are dropped below debug level,
 * a `userSub` is hashed, and an `error` field is reduced to its message, so provider detail stays readable.
 */
export const log = createLog('worker');
