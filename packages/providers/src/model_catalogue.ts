import { BedrockClient, ListFoundationModelsCommand } from '@aws-sdk/client-bedrock';
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
 * as a deprecation notice, and its end of life as the retirement date.
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
  return catalogue;
}
