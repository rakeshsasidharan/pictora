import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { metricsNamespace, type Environment } from '@pictora/core';
import { powertoolsMetrics } from '@pictora/core/observability';
import { createRegistryLoader, dynamoRegistrySource } from '@pictora/core/registry-store';
import {
  DEFAULT_ADAPTERS,
  GeminiProvider,
  OpenAiProvider,
  createBatchProviderFactory,
  createModerator,
  createProviderFactory,
  geminiConfigFromEnv,
  secretApiKey,
  secretString,
} from '@pictora/providers';
import { ulid } from 'ulid';
import type { BatchDeps } from './batch.js';
import type { TableContext } from './job_store.js';
import { moderateImageRequests } from './moderation.js';
import type { PipelineDeps } from './pipeline.js';

/**
 * The environment the worker runs in, from `PICTORA_ENV`. Anything else counts as prod, so a misconfigured
 * deploy never runs the dev-only mock model.
 */
export function workerEnvironment(env: NodeJS.ProcessEnv = process.env): Environment {
  return env.PICTORA_ENV === 'dev' ? 'dev' : 'prod';
}

function required(name: string, env: NodeJS.ProcessEnv): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/** The table from `TABLE_NAME`. `DYNAMODB_ENDPOINT` points the client at DynamoDB Local. */
export function tableContext(env: NodeJS.ProcessEnv = process.env): TableContext {
  const endpoint = env.DYNAMODB_ENDPOINT;
  return {
    client: DynamoDBDocumentClient.from(new DynamoDBClient(endpoint ? { endpoint } : {}), {
      marshallOptions: { removeUndefinedValues: true },
    }),
    tableName: required('TABLE_NAME', env),
  };
}

/** The monthly cap on platform provider spend from `SPEND_CAP_CENTS`, set per environment by CDK. */
export function spendCapCents(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(required('SPEND_CAP_CENTS', env));
  if (!Number.isInteger(value) || value < 0) throw new Error('SPEND_CAP_CENTS is not valid');
  return value;
}

/** The provider adapters with their secrets: OpenAI and Gemini read theirs from Secrets Manager. */
function adapters(env: NodeJS.ProcessEnv, openAiKey: () => Promise<string>) {
  const geminiSecretId = required('GEMINI_SECRET_ID', env);
  const geminiConfig = geminiConfigFromEnv(env);
  return {
    ...DEFAULT_ADAPTERS,
    openai: () => new OpenAiProvider({ apiKey: openAiKey }),
    gemini: () =>
      new GeminiProvider({ config: geminiConfig, credential: secretString(geminiSecretId) }),
  };
}

/** Everything the pipeline and the batch Lambdas share: the table, bucket, registry, moderation and metrics. */
function sharedDeps(
  env: NodeJS.ProcessEnv,
  bucket: string,
  openAiKey: () => Promise<string>,
): Omit<PipelineDeps, 'provider' | 'providerTimeoutMs'> {
  const table = tableContext(env);
  const registry = createRegistryLoader({
    source: dynamoRegistrySource(table.client, table.tableName),
    environment: workerEnvironment(env),
  });
  return {
    ...table,
    s3: new S3Client({}),
    bucket,
    models: () => registry.models(),
    moderate: moderateImageRequests(createModerator({ apiKey: openAiKey })),
    metrics: powertoolsMetrics(env),
    spend: {
      capCents: spendCapCents(env),
      namespace: metricsNamespace(required('PICTORA_ENV', env)),
    },
    now: () => new Date(),
    newImageId: () => ulid(),
  };
}

/**
 * The generate pipeline's dependencies in a deployed worker: DynamoDB, the images bucket (`IMAGES_BUCKET`), the
 * registry cached for 60 s, the provider adapters, and moderation. The OpenAI adapter and moderation share the
 * key from the secret named in `OPENAI_SECRET_ID`, cached for 5 minutes. The Gemini adapter reads the secret
 * named in `GEMINI_SECRET_ID` and its backend from `GEMINI_BACKEND` (`geminiConfigFromEnv`). The month's
 * platform spend is published to `Pictora/<PICTORA_ENV>` with the cap from `SPEND_CAP_CENTS`.
 */
export function pipelineDeps(env: NodeJS.ProcessEnv = process.env): PipelineDeps {
  const bucket = required('IMAGES_BUCKET', env);
  const openAiKey = secretApiKey(required('OPENAI_SECRET_ID', env));
  const providers = adapters(env, openAiKey);
  return {
    ...sharedDeps(env, bucket, openAiKey),
    provider: createProviderFactory({ adapters: providers }),
  };
}

/**
 * The batch submitter's and poller's dependencies (tech design 5.4): the pipeline's, with the OpenAI, Gemini and
 * mock adapters' batch calls in place of single calls.
 */
export function batchDeps(env: NodeJS.ProcessEnv = process.env): BatchDeps {
  const bucket = required('IMAGES_BUCKET', env);
  const openAiKey = secretApiKey(required('OPENAI_SECRET_ID', env));
  const providers = adapters(env, openAiKey);
  return {
    ...sharedDeps(env, bucket, openAiKey),
    batchProvider: createBatchProviderFactory(providers),
  };
}
