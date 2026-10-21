import { createHash } from 'node:crypto';
import { Logger } from '@aws-lambda-powertools/logger';
import { MetricUnit, Metrics } from '@aws-lambda-powertools/metrics';
import { metricsNamespace } from './platform_cap.js';

/**
 * The custom metrics (tech design 11), in namespace `Pictora/<env>`. Every metric carries the dimension
 * `service = pictora`, which Powertools always adds; `ProviderLatencyMs` also carries `provider`.
 */
export const METRIC_NAMES = [
  'JobsCreated',
  'JobsSucceeded',
  'JobsFailed',
  'JobsBlocked',
  'ProviderLatencyMs',
  'ProviderCostCents',
  'PointsReserved',
  'EnhancerLatencyMs',
  'ModelHealthProblems',
] as const;
export type MetricName = (typeof METRIC_NAMES)[number];

/** The `service` dimension on every metric. */
export const METRICS_SERVICE = 'pictora';

export { metricsNamespace };

/** One data point; a metric with dimensions beyond `service` is published on its own. */
export interface MetricPoint {
  name: MetricName;
  value: number;
  unit: 'Count' | 'Milliseconds';
  dimensions?: Record<string, string>;
}

/** Publishes data points straight away, so long-lived servers and Lambda handlers can share it. */
export type EmitMetrics = (points: MetricPoint[]) => void;

/**
 * Powertools Metrics as Embedded Metric Format log lines in `Pictora/<PICTORA_ENV>` (`Pictora/local` without
 * it). `POWERTOOLS_METRICS_DISABLED` turns it off, as tests do.
 */
export function powertoolsMetrics(env: NodeJS.ProcessEnv = process.env): EmitMetrics {
  const metrics = new Metrics({
    namespace: metricsNamespace(env.PICTORA_ENV || 'local'),
    serviceName: METRICS_SERVICE,
  });
  return (points) => {
    for (const point of points) {
      const unit = point.unit === 'Milliseconds' ? MetricUnit.Milliseconds : MetricUnit.Count;
      if (point.dimensions) {
        const single = metrics.singleMetric();
        for (const [name, value] of Object.entries(point.dimensions)) {
          single.addDimension(name, value);
        }
        single.addMetric(point.name, unit, point.value);
      } else {
        metrics.addMetric(point.name, unit, point.value);
      }
    }
    if (points.some((point) => !point.dimensions)) metrics.publishStoredMetrics();
  };
}

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

/** Writes one JSON log line with extra fields. */
export type Log = (level: LogLevel, message: string, fields?: Record<string, unknown>) => void;

/** Fields that hold a user's words. They are only ever logged at debug level (tech design 11). */
export const PROMPT_FIELDS = [
  'prompt',
  'enhancedPrompt',
  'sentPrompt',
  'avoid',
  'negativePrompt',
  'instruction',
  'editInstruction',
] as const;

/** The fields without any user prompt text, unless the line is a debug line. */
export function redactPrompts(
  level: LogLevel,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  if (level === 'DEBUG') return fields;
  const redacted = { ...fields };
  for (const field of PROMPT_FIELDS) delete redacted[field];
  return redacted;
}

/** A user's `sub` as logged: a short SHA-256, so logs can follow one user without naming them. */
export function hashUserSub(sub: string): string {
  return createHash('sha256').update(sub).digest('hex').slice(0, 16);
}

/** The part of a Powertools Logger the log function uses, so tests can capture lines. */
export type LogSink = Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>;

/**
 * A Powertools Logger for one component (`pictora-<service>`), as a log function. Prompts are dropped below debug
 * level, a raw `userSub` is hashed, and an `error` is reduced to its message so provider detail stays readable.
 * The level comes from `POWERTOOLS_LOG_LEVEL` (INFO by default).
 */
export function createLog(
  service: string,
  sink: LogSink = new Logger({ serviceName: `pictora-${service}` }),
): Log {
  return (level, message, fields = {}) => {
    const { error, userSub, ...rest } = redactPrompts(level, fields);
    const extra = {
      ...rest,
      ...(typeof userSub === 'string' ? { userSub: hashUserSub(userSub) } : {}),
      ...(error === undefined
        ? {}
        : { error: error instanceof Error ? error.message : String(error) }),
    };
    if (level === 'DEBUG') sink.debug(message, extra);
    else if (level === 'INFO') sink.info(message, extra);
    else if (level === 'WARN') sink.warn(message, extra);
    else sink.error(message, extra);
  };
}
