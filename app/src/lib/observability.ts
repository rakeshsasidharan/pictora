import { createLog, powertoolsMetrics, type EmitMetrics } from '@pictora/core/observability';

/**
 * The app's Powertools logger (tech design 11): JSON lines from `pictora-app`, with prompts left out below debug
 * level and `userSub` hashed.
 */
export const log = createLog('app');

let metrics: EmitMetrics | undefined;

/** The app's metrics in `Pictora/<PICTORA_ENV>`, created once per server. */
export function appMetrics(): EmitMetrics {
  metrics ??= powertoolsMetrics();
  return metrics;
}
