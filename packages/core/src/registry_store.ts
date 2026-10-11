import {
  BatchWriteCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import {
  modelConfigSchema,
  modelsForEnvironment,
  type Environment,
  type ModelConfig,
} from './registry.js';

/**
 * The model registry in DynamoDB (tech design 4 and 6.1). Each model is `MODEL#<id>` / `CONFIG`, and every
 * registry item also carries `GSI1PK = REGISTRY` and `GSI1SK = <id>`, so the whole registry is one GSI1 query.
 */
export const REGISTRY_INDEX = 'GSI1';
export const REGISTRY_GSI_PK = 'REGISTRY';
export const MODEL_SK = 'CONFIG';

/** The app and the worker cache the registry for 60 s, so a kill switch takes effect within a minute (ADM-2). */
export const REGISTRY_CACHE_MS = 60_000;

const KEY_ATTRIBUTES = ['PK', 'SK', 'GSI1PK', 'GSI1SK'] as const;

/** DynamoDB items are at most 25 to a BatchWriteItem call. */
const BATCH_SIZE = 25;
const MAX_BATCH_ATTEMPTS = 5;

export type RegistryItem = Record<string, unknown>;

export function modelPk(modelId: string): string {
  return `MODEL#${modelId}`;
}

/** The DynamoDB item for a registry entry. */
export function registryItem(model: ModelConfig): RegistryItem {
  return {
    PK: modelPk(model.id),
    SK: MODEL_SK,
    GSI1PK: REGISTRY_GSI_PK,
    GSI1SK: model.id,
    ...model,
  };
}

/** The registry entry in an item, or undefined when the item doesn't hold a valid entry. */
export function modelFromItem(item: RegistryItem): ModelConfig | undefined {
  const entry: RegistryItem = { ...item };
  for (const key of KEY_ATTRIBUTES) delete entry[key];
  const parsed = modelConfigSchema.safeParse(entry);
  return parsed.success ? parsed.data : undefined;
}

/** Every registry item in the table, from one paginated GSI1 query. */
export async function queryRegistryItems(
  client: DynamoDBDocumentClient,
  tableName: string,
): Promise<RegistryItem[]> {
  const items: RegistryItem[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await client.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: REGISTRY_INDEX,
        KeyConditionExpression: 'GSI1PK = :registry',
        ExpressionAttributeValues: { ':registry': REGISTRY_GSI_PK },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    items.push(...((page.Items ?? []) as RegistryItem[]));
    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return items;
}

/** What a seed run writes, and what happened to each model's kill switch. */
export interface SeedPlan {
  /** Every item to put: the seed entries, then the models no longer in the seed. */
  items: RegistryItem[];
  /** In the seed but not in DynamoDB: `enabled` comes from the seed. */
  added: string[];
  /** In both: `enabled` keeps the DynamoDB value, so a switched-off model stays off. */
  kept: string[];
  /** In DynamoDB but not in the seed: marked `enabled: false`, never deleted. */
  removed: string[];
}

/**
 * Plans the upsert of the seed (`models.json`) over the registry items already in DynamoDB. Seed entries replace
 * the stored config but keep the stored `enabled`, so a rollback or redeploy never re-enables a model switched
 * off by hand. New models take `enabled` from the seed. Models dropped from the seed are switched off.
 */
export function planRegistrySeed(
  seed: readonly ModelConfig[],
  existing: readonly RegistryItem[],
): SeedPlan {
  const stored = new Map<string, RegistryItem>();
  for (const item of existing) {
    if (typeof item.GSI1SK === 'string') stored.set(item.GSI1SK, item);
  }
  const plan: SeedPlan = { items: [], added: [], kept: [], removed: [] };
  const seedIds = new Set<string>();

  for (const model of seed) {
    seedIds.add(model.id);
    const current = stored.get(model.id);
    if (current && typeof current.enabled === 'boolean') {
      plan.kept.push(model.id);
      plan.items.push(registryItem({ ...model, enabled: current.enabled }));
    } else {
      plan.added.push(model.id);
      plan.items.push(registryItem(model));
    }
  }
  for (const [id, item] of stored) {
    if (seedIds.has(id)) continue;
    plan.removed.push(id);
    plan.items.push({ ...item, enabled: false });
  }
  return plan;
}

/** Reads the stored registry, applies `planRegistrySeed` and writes the result. Returns the plan. */
export async function seedRegistry(
  client: DynamoDBDocumentClient,
  tableName: string,
  seed: readonly ModelConfig[],
): Promise<SeedPlan> {
  const plan = planRegistrySeed(seed, await queryRegistryItems(client, tableName));
  for (let start = 0; start < plan.items.length; start += BATCH_SIZE) {
    await writeBatch(client, tableName, plan.items.slice(start, start + BATCH_SIZE));
  }
  return plan;
}

async function writeBatch(
  client: DynamoDBDocumentClient,
  tableName: string,
  items: RegistryItem[],
): Promise<void> {
  let requests = items.map((Item) => ({ PutRequest: { Item } }));
  for (let attempt = 1; requests.length > 0; attempt++) {
    if (attempt > MAX_BATCH_ATTEMPTS) {
      throw new Error(`${requests.length} registry items were still unprocessed after retries`);
    }
    const result = await client.send(
      new BatchWriteCommand({ RequestItems: { [tableName]: requests } }),
    );
    requests = (result.UnprocessedItems?.[tableName] ?? []) as typeof requests;
    if (requests.length > 0)
      await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
  }
}

/** Where a loader gets the registry from. */
export type RegistrySource = () => Promise<ModelConfig[]>;

/** The registry in DynamoDB, skipping items that don't hold a valid entry. */
export function dynamoRegistrySource(
  client: DynamoDBDocumentClient,
  tableName: string,
): RegistrySource {
  return async () =>
    (await queryRegistryItems(client, tableName))
      .map(modelFromItem)
      .filter((model): model is ModelConfig => model !== undefined);
}

/**
 * The models an environment may offer: listed for it, and never `mock` in prod. Includes switched-off models;
 * see `enabledModels`.
 */
export function modelsAvailableIn(
  models: readonly ModelConfig[],
  environment: Environment,
): ModelConfig[] {
  return modelsForEnvironment(models, environment).filter(
    (model) => environment !== 'prod' || model.provider !== 'mock',
  );
}

export interface RegistryLoader {
  /** The environment's models, including switched-off ones, so callers can tell "off" from "unknown". */
  models(): Promise<ModelConfig[]>;
  /** The environment's models that are switched on, as `/api/models` lists them. */
  enabledModels(): Promise<ModelConfig[]>;
}

export interface RegistryLoaderOptions {
  source: RegistrySource;
  environment: Environment;
  cacheMs?: number;
  now?: () => number;
}

/**
 * A registry loader for the app and the worker: reads the registry and keeps it in memory for 60 s. If a refresh
 * fails, it keeps serving the last registry it read; with none, the error propagates.
 */
export function createRegistryLoader(options: RegistryLoaderOptions): RegistryLoader {
  const { source, environment } = options;
  const cacheMs = options.cacheMs ?? REGISTRY_CACHE_MS;
  const now = options.now ?? Date.now;
  let cached: { models: ModelConfig[]; expiresAt: number } | undefined;
  let pending: Promise<ModelConfig[]> | undefined;

  async function refresh(): Promise<ModelConfig[]> {
    try {
      const models = modelsAvailableIn(await source(), environment);
      cached = { models, expiresAt: now() + cacheMs };
      return models;
    } catch (error) {
      if (cached) return cached.models;
      throw error;
    } finally {
      pending = undefined;
    }
  }

  async function models(): Promise<ModelConfig[]> {
    if (cached && cached.expiresAt > now()) return cached.models;
    pending ??= refresh();
    return pending;
  }

  return {
    models,
    async enabledModels() {
      return (await models()).filter((model) => model.enabled);
    },
  };
}
