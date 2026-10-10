import { z } from 'zod';
import seedModels from '../models.json' with { type: 'json' };
import { mapAspect } from './size_mapping.js';
import { STYLE_IDS, type StyleId } from './styles.js';

export const QUALITIES = ['draft', 'standard', 'high'] as const;
export type Quality = (typeof QUALITIES)[number];

export const ASPECTS = ['1:1', '4:5', '3:2', '2:3', '16:9', '9:16'] as const;
export type Aspect = (typeof ASPECTS)[number];

/** Image providers behind the adapter interface. Bedrock arrives in P1; mock is dev only. */
export const PROVIDERS = ['openai', 'gemini', 'bedrock', 'mock'] as const;
export type Provider = (typeof PROVIDERS)[number];

export const ENVIRONMENTS = ['dev', 'prod'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

/** Most reference images any request may carry (EDIT-5). */
export const MAX_REFERENCE_IMAGES = 3;

export interface QualityConfig {
  /** Provider settings for this quality, e.g. OpenAI `quality` or Gemini `imageSize`. */
  providerParams: Record<string, unknown>;
  /** Points per image: provider list price in cents, rounded up. */
  costPoints: number;
}

/** One model registry entry (tech design section 6.1). */
export interface ModelConfig {
  /** Stable Pictora id. */
  id: string;
  provider: Provider;
  /** The model id sent to the provider. */
  providerModelId: string;
  displayName: string;
  strengths: string[];
  /** Kill switch (ADM-2). */
  enabled: boolean;
  /** `mock` is dev only. */
  environments: Environment[];
  capabilities: {
    generate: boolean;
    edit: boolean;
    transparentBackground: boolean;
    negativePrompt: boolean;
    seed: boolean;
    /** Most reference images accepted. */
    referenceImages: number;
    aspects: Aspect[];
  };
  qualities: Partial<Record<Quality, QualityConfig>>;
  /** Style presets this model is the default for. */
  defaultFor: StyleId[];
  /** ISO date; alert 60 days before (PRD risk table). */
  eolDate?: string;
}

export const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9.-]*$/;

const qualityConfigSchema = z.strictObject({
  providerParams: z.record(z.string(), z.unknown()),
  costPoints: z.int().positive(),
});

export const modelConfigSchema = z.strictObject({
  id: z.string().regex(MODEL_ID_PATTERN).max(64),
  provider: z.enum(PROVIDERS),
  providerModelId: z.string().min(1),
  displayName: z.string().min(1),
  strengths: z.array(z.string().min(1)).min(1),
  enabled: z.boolean(),
  environments: z.array(z.enum(ENVIRONMENTS)).min(1),
  capabilities: z.strictObject({
    generate: z.boolean(),
    edit: z.boolean(),
    transparentBackground: z.boolean(),
    negativePrompt: z.boolean(),
    seed: z.boolean(),
    referenceImages: z.int().min(0).max(MAX_REFERENCE_IMAGES),
    aspects: z.array(z.enum(ASPECTS)).min(1),
  }),
  qualities: z.partialRecord(z.enum(QUALITIES), qualityConfigSchema),
  defaultFor: z.array(z.enum(STYLE_IDS)),
  eolDate: z.iso.date().optional(),
}) satisfies z.ZodType<ModelConfig>;

export interface RegistryValidation {
  /** The entries that parsed, whether or not the registry as a whole is valid. */
  models: ModelConfig[];
  /** Every problem found; empty when the registry is valid. */
  errors: string[];
}

export class RegistryValidationError extends Error {
  constructor(readonly errors: string[]) {
    super(`Invalid model registry:\n${errors.map((error) => `- ${error}`).join('\n')}`);
    this.name = 'RegistryValidationError';
  }
}

/**
 * Checks a registry (the contents of `models.json`): entry shape, unique ids, a cost for every quality, a size
 * mapping for every listed aspect, and exactly one default model per style in each environment.
 */
export function validateRegistry(input: unknown): RegistryValidation {
  if (!Array.isArray(input))
    return { models: [], errors: ['The registry must be an array of models'] };

  const errors: string[] = [];
  const models: ModelConfig[] = [];
  input.forEach((entry: unknown, index) => {
    const parsed = modelConfigSchema.safeParse(entry);
    const label = describeEntry(entry, index);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
        errors.push(`${label}: ${path}${issue.message}`);
      }
      return;
    }
    models.push(parsed.data);
  });

  const seen = new Set<string>();
  for (const model of models) {
    if (seen.has(model.id)) errors.push(`Duplicate model id: ${model.id}`);
    seen.add(model.id);
    errors.push(...checkModel(model));
  }
  errors.push(...checkStyleDefaults(models));

  return { models, errors };
}

/** Like `validateRegistry`, but returns the models only when the registry is valid, and throws otherwise. */
export function parseRegistry(input: unknown): ModelConfig[] {
  const { models, errors } = validateRegistry(input);
  if (errors.length > 0) throw new RegistryValidationError(errors);
  return models;
}

/** The validated seed registry from `packages/core/models.json`. */
export function loadSeedRegistry(): ModelConfig[] {
  return parseRegistry(seedModels);
}

/** Models that run in the environment; `enabled` is checked separately so kill switches stay visible. */
export function modelsForEnvironment(
  models: readonly ModelConfig[],
  environment: Environment,
): ModelConfig[] {
  return models.filter((model) => model.environments.includes(environment));
}

export function findModel(models: readonly ModelConfig[], id: string): ModelConfig | undefined {
  return models.find((model) => model.id === id);
}

export function isQuality(value: string): value is Quality {
  return (QUALITIES as readonly string[]).includes(value);
}

export function isAspect(value: string): value is Aspect {
  return (ASPECTS as readonly string[]).includes(value);
}

function describeEntry(entry: unknown, index: number): string {
  const id =
    typeof entry === 'object' && entry !== null ? (entry as { id?: unknown }).id : undefined;
  return typeof id === 'string' ? `Model ${id}` : `Model at index ${index}`;
}

function checkModel(model: ModelConfig): string[] {
  const errors: string[] = [];
  const label = `Model ${model.id}`;
  const qualities = QUALITIES.filter((quality) => model.qualities[quality] !== undefined);

  if (qualities.length === 0) errors.push(`${label}: has no qualities with a cost`);
  if (!model.capabilities.generate && !model.capabilities.edit) {
    errors.push(`${label}: supports neither generate nor edit`);
  }
  if (new Set(model.capabilities.aspects).size !== model.capabilities.aspects.length) {
    errors.push(`${label}: lists an aspect more than once`);
  }
  if (new Set(model.environments).size !== model.environments.length) {
    errors.push(`${label}: lists an environment more than once`);
  }
  if (new Set(model.defaultFor).size !== model.defaultFor.length) {
    errors.push(`${label}: lists a style in defaultFor more than once`);
  }
  if (model.provider === 'mock' && model.environments.includes('prod')) {
    errors.push(`${label}: mock models are dev only`);
  }
  for (const quality of qualities) {
    for (const aspect of model.capabilities.aspects) {
      try {
        mapAspect(model, aspect, quality);
      } catch (error) {
        errors.push(`${label}: ${(error as Error).message}`);
      }
    }
  }
  return errors;
}

function checkStyleDefaults(models: readonly ModelConfig[]): string[] {
  const errors: string[] = [];
  for (const environment of ENVIRONMENTS) {
    const available = modelsForEnvironment(models, environment);
    for (const style of STYLE_IDS) {
      const defaults = available
        .filter((model) => model.defaultFor.includes(style))
        .map((model) => model.id);
      if (defaults.length === 0)
        errors.push(`Style ${style} has no default model in ${environment}`);
      if (defaults.length > 1) {
        errors.push(
          `Style ${style} has more than one default model in ${environment}: ${defaults.join(', ')}`,
        );
      }
    }
  }
  return errors;
}
