import {
  BedrockClient,
  GetFoundationModelAvailabilityCommand,
  ListFoundationModelsCommand,
  paginateListInferenceProfiles,
} from '@aws-sdk/client-bedrock';
import { GoogleGenAI } from '@google/genai';
import OpenAI from 'openai';
import { BEDROCK_REGION } from './bedrock.js';
import { geminiClientOptions, type GeminiConfig } from './gemini.js';

/** What a provider says about one of its models: deprecated (legacy), and when it retires, if it says. */
export interface CatalogueEntry {
  legacy: boolean;
  /** `yyyy-mm-dd`. */
  endOfLife?: string;
}

/** A provider's models by their provider model ID, as its models list API returns them. */
export type ModelCatalogue = ReadonlyMap<string, CatalogueEntry>;

/** A models list call gets 30 s; it runs once a day, so one retry is enough. */
const CATALOGUE_TIMEOUT_MS = 30_000;

/** The Bedrock model provider whose models the registry uses (P1). */
export const BEDROCK_MODEL_PROVIDER = 'stability';

/** OpenAI's models list (`GET /v1/models`); OpenAI doesn't report deprecation there. */
export async function openAiModelCatalogue(options: {
  apiKey: string;
  baseURL?: string;
}): Promise<ModelCatalogue> {
  const client = new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseURL,
    maxRetries: 1,
    timeout: CATALOGUE_TIMEOUT_MS,
  });
  const catalogue = new Map<string, CatalogueEntry>();
  for await (const model of client.models.list()) catalogue.set(model.id, { legacy: false });
  return catalogue;
}

/**
 * The Gemini models list, through the same `@google/genai` client and backend the adapter uses. Names come back
 * as `models/<id>` (or `publishers/google/models/<id>` on Vertex AI), so only the last part is kept.
 */
export async function geminiModelCatalogue(options: {
  config: GeminiConfig;
  credential: string;
  baseUrl?: string;
}): Promise<ModelCatalogue> {
  const clientOptions = geminiClientOptions(options.config, options.credential, options.baseUrl);
  const client = new GoogleGenAI({
    ...clientOptions,
    httpOptions: { ...clientOptions.httpOptions, timeout: CATALOGUE_TIMEOUT_MS },
  });
  const catalogue = new Map<string, CatalogueEntry>();
  const pager = await client.models.list({ config: { pageSize: 1000 } });
  for await (const model of pager) {
    const id = model.name?.split('/').pop();
    if (id) catalogue.set(id, { legacy: false });
  }
  return catalogue;
}

/**
 * Bedrock's `ListFoundationModels` for Stability AI in us-west-2, with each model's lifecycle: `LEGACY` counts
 * as a deprecation notice, and its end of life as the retirement date. The system-defined inference profiles
 * that route to a Stability model are listed too, by profile ID: the image tools' models are reachable only
 * through one, so `ListFoundationModels` doesn't return them. A profile reports no lifecycle.
 */
export async function bedrockModelCatalogue(
  client: BedrockClient = new BedrockClient({ region: BEDROCK_REGION }),
): Promise<ModelCatalogue> {
  const result = await client.send(
    new ListFoundationModelsCommand({ byProvider: BEDROCK_MODEL_PROVIDER }),
  );
  const catalogue = new Map<string, CatalogueEntry>();
  for (const model of result.modelSummaries ?? []) {
    if (!model.modelId) continue;
    const endOfLife = model.modelLifecycle?.endOfLifeTime;
    catalogue.set(model.modelId, {
      legacy: model.modelLifecycle?.status === 'LEGACY',
      ...(endOfLife ? { endOfLife: endOfLife.toISOString().slice(0, 10) } : {}),
    });
  }
  const stabilityModel = `:foundation-model/${BEDROCK_MODEL_PROVIDER}.`;
  for await (const page of paginateListInferenceProfiles(
    { client },
    { typeEquals: 'SYSTEM_DEFINED' },
  )) {
    for (const profile of page.inferenceProfileSummaries ?? []) {
      if (!profile.inferenceProfileId || profile.status !== 'ACTIVE') continue;
      if (!profile.models?.some((model) => model.modelArn?.includes(stabilityModel))) continue;
      catalogue.set(profile.inferenceProfileId, { legacy: false });
    }
  }
  return catalogue;
}

/**
 * Whether this account may call a Bedrock model, from `GetFoundationModelAvailability`. A model can be listed
 * and active yet not callable: a model sold through AWS Marketplace needs an agreement (`agreement`), which
 * may not be offered to the account at all.
 */
export interface BedrockModelAccess {
  /** `AVAILABLE`, `PENDING`, `NOT_AVAILABLE` or `ERROR`. */
  agreement: string;
  /** `AUTHORIZED` or `NOT_AUTHORIZED`. */
  authorization: string;
  /** `AVAILABLE` or `NOT_AVAILABLE`. */
  entitlement: string;
  /** `AVAILABLE` or `NOT_AVAILABLE`. */
  region: string;
}

/** True when every part of the access says the model can be called. */
export function bedrockModelCallable(access: BedrockModelAccess): boolean {
  return (
    access.agreement === 'AVAILABLE' &&
    access.authorization === 'AUTHORIZED' &&
    access.entitlement === 'AVAILABLE' &&
    access.region === 'AVAILABLE'
  );
}

/**
 * The account's access to a Bedrock model, by foundation model ID or system-defined inference profile ID (both
 * are accepted), or `undefined` when Bedrock doesn't know the ID. Any other failure is thrown, so an outage
 * isn't reported as a missing model.
 */
export async function bedrockModelAccess(
  modelId: string,
  client: BedrockClient = new BedrockClient({ region: BEDROCK_REGION }),
): Promise<BedrockModelAccess | undefined> {
  try {
    const result = await client.send(new GetFoundationModelAvailabilityCommand({ modelId }));
    return {
      agreement: result.agreementAvailability?.status ?? 'ERROR',
      authorization: result.authorizationStatus ?? 'NOT_AUTHORIZED',
      entitlement: result.entitlementAvailability ?? 'NOT_AVAILABLE',
      region: result.regionAvailability ?? 'NOT_AVAILABLE',
    };
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    // An unknown ID is a ValidationException ("The provided model identifier is invalid").
    if (name === 'ResourceNotFoundException' || name === 'ValidationException') return undefined;
    throw error;
  }
}
