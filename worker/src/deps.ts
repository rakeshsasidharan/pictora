import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { Environment } from '@pictora/core';
import { createRegistryLoader, dynamoRegistrySource } from '@pictora/core/registry-store';
import {
  DEFAULT_ADAPTERS,
  GeminiProvider,
  OpenAiProvider,
  createModerator,
  createProviderFactory,
  geminiConfigFromEnv,
  secretApiKey,
  secretString,
} from '@pictora/providers';
import { ulid } from 'ulid';
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

/**
 * The generate pipeline's dependencies in a deployed worker: DynamoDB, the images bucket (`IMAGES_BUCKET`), the
 * registry cached for 60 s, the provider adapters, and moderation. The OpenAI adapter and moderation share the
 * key from the secret named in `OPENAI_SECRET_ID`, cached for 5 minutes. The Gemini adapter reads the secret
 * named in `GEMINI_SECRET_ID` and its backend from `GEMINI_BACKEND` (`geminiConfigFromEnv`).
 */
export function pipelineDeps(env: NodeJS.ProcessEnv = process.env): PipelineDeps {
  const table = tableContext(env);
  const bucket = required('IMAGES_BUCKET', env);
  const openAiKey = secretApiKey(required('OPENAI_SECRET_ID', env));
  const geminiSecretId = required('GEMINI_SECRET_ID', env);
  const geminiConfig = geminiConfigFromEnv(env);
  const registry = createRegistryLoader({
    source: dynamoRegistrySource(table.client, table.tableName),
    environment: workerEnvironment(env),
  });
  return {
    ...table,
    s3: new S3Client({}),
    bucket,
    models: () => registry.models(),
    provider: createProviderFactory({
      adapters: {
        ...DEFAULT_ADAPTERS,
        openai: () => new OpenAiProvider({ apiKey: openAiKey }),
        gemini: () =>
          new GeminiProvider({ config: geminiConfig, credential: secretString(geminiSecretId) }),
      },
    }),
    moderate: moderateImageRequests(createModerator({ apiKey: openAiKey })),
    now: () => new Date(),
    newImageId: () => ulid(),
  };
}
