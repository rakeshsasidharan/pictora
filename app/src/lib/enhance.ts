import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  RATE_TTL_SECONDS,
  SECONDS_PER_DAY,
  STATS_TTL_DAYS,
  blockingCategory,
  enhanceRequestSchema,
  rateLimitPerMinute,
  rateSk,
  statsEnhancerSk,
  statsPk,
  stylePreset,
  ttlAfter,
  userPk,
  utcDate,
  utcMinute,
  type ModelConfig,
} from '@pictora/core';
import type { EmitMetrics } from '@pictora/core/observability';
import type { Enhance, Moderate } from '@pictora/providers/text';
import { apiError, logError, profileRefusal, type ApiResult } from './jobs';
import { ensureProfile } from './profile';
import type { Session } from './session';

/** What the enhancer API needs, so tests can swap the enhancer, moderation and the clock. */
export interface EnhanceDeps {
  client: DynamoDBDocumentClient;
  tableName: string;
  /** The environment's registry, switched-off models included. */
  models: () => Promise<ModelConfig[]>;
  moderate: Moderate;
  enhance: Enhance;
  /** The enhancer model as configured (`ENHANCER_MODEL`), for the stats. */
  enhancerModel: string;
  now: () => Date;
  /** Publishes `EnhancerLatencyMs` (tech design 11) when set. */
  metrics?: EmitMetrics;
}

/** The `POST /api/enhance` body. `fallback` means the output failed moderation, so it is the user's words. */
export interface EnhanceBody {
  enhancedPrompt: string;
  fallback?: true;
}

/**
 * `POST /api/enhance` (ENH-1 to ENH-4, tech design 6.3): checks the account and the shared job rate window,
 * moderates the user's words, rewrites them with the enhancer, and moderates the result. When the result is
 * flagged, or its check fails, the answer is the user's own words with `fallback: true`. The call's tokens and
 * cost are added to the day's stats as overhead; users are never charged for it.
 */
export async function enhancePrompt(
  deps: EnhanceDeps,
  session: Session,
  input: unknown,
): Promise<ApiResult> {
  const parsed = enhanceRequestSchema.safeParse(input);
  if (!parsed.success) {
    return apiError('invalid_request', 'Write a prompt of up to 2,000 characters to enhance.');
  }
  const { prompt, style, modelId } = parsed.data;
  const model = (await deps.models()).find((candidate) => candidate.id === modelId);
  if (!model) return apiError('unknown_model', "That model isn't available. Pick another model.");

  const now = deps.now();
  const profile = await ensureProfile(deps.client, deps.tableName, session, now);
  const refusal = profileRefusal(profile, now);
  if (refusal) return refusal;
  const rateLimit = rateLimitPerMinute(session.groups);
  if (!(await takeRateSlot(deps.client, deps.tableName, session.sub, now, rateLimit))) {
    return apiError(
      'rate_limited',
      `You've made ${rateLimit} requests in the last minute. Wait a moment, then try again.`,
    );
  }

  try {
    if (blockingCategory(await deps.moderate({ text: prompt }))) {
      return apiError(
        'blocked',
        'This prompt was blocked by our content policy. Try rewording it.',
      );
    }
  } catch (error) {
    logError('Enhancer input moderation failed', { error });
    return enhancerUnavailable();
  }

  let enhancedPrompt: string;
  try {
    const result = await deps.enhance({
      prompt,
      styleText: stylePreset(style).styleText,
      model,
    });
    enhancedPrompt = result.enhancedPrompt;
    deps.metrics?.([{ name: 'EnhancerLatencyMs', value: result.latencyMs, unit: 'Milliseconds' }]);
    const flagged = await outputFlagged(deps, enhancedPrompt);
    await recordEnhancerStats(deps, now, { ...result, fallback: flagged });
    if (flagged) return { status: 200, body: { enhancedPrompt: prompt, fallback: true } };
  } catch (error) {
    logError('Prompt enhancer failed', { enhancerModel: deps.enhancerModel, error });
    await recordEnhancerStats(deps, now, { failure: true });
    return enhancerUnavailable();
  }
  return { status: 200, body: { enhancedPrompt } };
}

function enhancerUnavailable(): ApiResult {
  return apiError(
    'enhance_failed',
    "The prompt enhancer isn't available right now, so your own words will be used.",
  );
}

/** True when the enhancer's output must not be used: it was flagged, or its check failed (ENH-4). */
async function outputFlagged(deps: EnhanceDeps, enhancedPrompt: string): Promise<boolean> {
  try {
    return blockingCategory(await deps.moderate({ text: enhancedPrompt })) !== undefined;
  } catch (error) {
    logError('Enhancer output moderation failed; using the original prompt', { error });
    return true;
  }
}

/**
 * Counts the call in the minute's rate window that job creation also uses (tech design 4.1). False when the
 * user already made `max` requests this minute (`rateLimitPerMinute`).
 */
export async function takeRateSlot(
  client: DynamoDBDocumentClient,
  tableName: string,
  sub: string,
  now: Date,
  max: number,
): Promise<boolean> {
  try {
    await client.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { PK: userPk(sub), SK: rateSk(utcMinute(now)) },
        UpdateExpression: 'ADD #count :one SET #ttl = :ttl',
        ConditionExpression: 'attribute_not_exists(#count) OR #count < :max',
        ExpressionAttributeNames: { '#count': 'count', '#ttl': 'ttl' },
        ExpressionAttributeValues: {
          ':one': 1,
          ':max': max,
          ':ttl': ttlAfter(now, RATE_TTL_SECONDS),
        },
      }),
    );
    return true;
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) return false;
    throw error;
  }
}

type EnhancerOutcome =
  | { inputTokens: number; outputTokens: number; costCents: number; fallback: boolean }
  | { failure: true };

/**
 * Adds the call to `STATS#<today>` / `ENHANCER#<model>`: calls, tokens, cost in cents, fallbacks and failures.
 * Best effort: a failed write is logged, never shown to the user.
 */
async function recordEnhancerStats(
  deps: EnhanceDeps,
  now: Date,
  outcome: EnhancerOutcome,
): Promise<void> {
  const counters: Record<string, number> =
    'failure' in outcome
      ? { calls: 1, failures: 1 }
      : {
          calls: 1,
          inputTokens: outcome.inputTokens,
          outputTokens: outcome.outputTokens,
          costCents: outcome.costCents,
          fallbacks: outcome.fallback ? 1 : 0,
        };
  const names = Object.keys(counters);
  try {
    await deps.client.send(
      new UpdateCommand({
        TableName: deps.tableName,
        Key: { PK: statsPk(utcDate(now)), SK: statsEnhancerSk(deps.enhancerModel) },
        UpdateExpression: `ADD ${names.map((name) => `#${name} :${name}`).join(', ')} SET #ttl = :ttl`,
        ExpressionAttributeNames: {
          ...Object.fromEntries(names.map((name) => [`#${name}`, name])),
          '#ttl': 'ttl',
        },
        ExpressionAttributeValues: {
          ...Object.fromEntries(names.map((name) => [`:${name}`, counters[name]])),
          ':ttl': ttlAfter(now, STATS_TTL_DAYS * SECONDS_PER_DAY),
        },
      }),
    );
  } catch (error) {
    logError('Enhancer stats update failed', { error });
  }
}
