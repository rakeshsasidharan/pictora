import {
  ENVIRONMENTS,
  PROVIDERS,
  QUALITIES,
  mapAspect,
  modelsForEnvironment,
  type Environment,
  type ModelConfig,
  type Provider,
  type Quality,
} from '@pictora/core';
import sharp from 'sharp';
import { ProviderError, ProviderSafetyError } from '../src/errors.js';
import { guardProvider } from '../src/factory.js';
import { normalisePng } from '../src/image.js';
import { providerSignal } from '../src/retry.js';
import type { ImageProvider, ImageRequest, ImageResult } from '../src/types.js';

/**
 * The live provider check (tech design 13): one draft image per enabled model with real credentials, run by
 * hand on a laptop before a prod release. Never run in CI. OpenAI and Bedrock go through their adapters, and
 * models that offer transparent backgrounds get a second check that the PNG has an alpha channel (GEN-9).
 * Gemini is called through the small client below until its adapter (#15) exists.
 */

export const CHECK_PROMPT = 'A red apple on a wooden table, soft daylight';
export const OPENAI_API_URL = 'https://api.openai.com/v1';
export const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta';
export const OPENAI_MODERATION_MODEL = 'omni-moderation-latest';

/** Providers with live models; the mock provider has nothing to check. */
export const LIVE_PROVIDERS = PROVIDERS.filter(
  (provider): provider is Exclude<Provider, 'mock'> => provider !== 'mock',
);
export type LiveProvider = (typeof LIVE_PROVIDERS)[number];

export type FetchFn = typeof fetch;

export interface CheckOptions {
  env: Environment;
  providers: LiveProvider[];
  /** Where the PNGs are written; a new temp folder when not given. */
  outDir?: string;
}

/** Parses `--env dev|prod`, `--provider openai,gemini,bedrock` and `--out <dir>`. */
export function parseArgs(argv: readonly string[]): CheckOptions {
  const options: CheckOptions = { env: 'dev', providers: [...LIVE_PROVIDERS] };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag !== '--env' && flag !== '--provider' && flag !== '--out') {
      throw new Error(`Unknown option ${flag}. Use --env, --provider or --out.`);
    }
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    index++;
    if (flag === '--env') {
      if (!(ENVIRONMENTS as readonly string[]).includes(value)) {
        throw new Error(`--env must be one of ${ENVIRONMENTS.join(', ')}: ${value}`);
      }
      options.env = value as Environment;
    } else if (flag === '--provider') {
      const names = value.split(',').map((name) => name.trim());
      for (const name of names) {
        if (!(LIVE_PROVIDERS as readonly string[]).includes(name)) {
          throw new Error(`--provider must be from ${LIVE_PROVIDERS.join(', ')}: ${name}`);
        }
      }
      options.providers = [...new Set(names)] as LiveProvider[];
    } else {
      options.outDir = value;
    }
  }
  return options;
}

/** Enabled models for the environment from the chosen providers, in registry order. */
export function selectModels(
  models: readonly ModelConfig[],
  env: Environment,
  providers: readonly LiveProvider[],
): ModelConfig[] {
  return modelsForEnvironment(models, env).filter(
    (model) =>
      model.enabled &&
      model.capabilities.generate &&
      (providers as readonly Provider[]).includes(model.provider),
  );
}

/** The cheapest quality the model offers: draft when it has one. */
export function cheapestQuality(model: ModelConfig): Quality {
  const quality = QUALITIES.find((name) => model.qualities[name] !== undefined);
  if (!quality) throw new Error(`Model ${model.id} has no qualities`);
  return quality;
}

/** Secrets Manager names for the provider keys (tech design 10). */
export function secretName(env: Environment, provider: 'openai' | 'gemini'): string {
  return `pictora/${env}/${provider}`;
}

/** Throws a typed error for a failed HTTP response, using the provider's error message when it sends one. */
async function assertOk(response: Response, provider: string): Promise<void> {
  if (response.ok) return;
  let detail = response.statusText;
  try {
    const body = (await response.json()) as { error?: { message?: unknown } };
    if (typeof body.error?.message === 'string') detail = body.error.message;
  } catch {
    // Keep the status text.
  }
  throw Object.assign(new Error(`${provider} HTTP ${response.status}: ${detail}`), {
    status: response.status,
  });
}

function unsupportedEdit(model: ModelConfig): Promise<ImageResult> {
  return Promise.reject(new ProviderError(`The live check only generates (model ${model.id})`));
}

/** OpenAI's moderation endpoint, checked once per run. Images go through the OpenAI adapter. */
export class OpenAiModerationCheck {
  constructor(
    private readonly apiKey: string,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  /** Runs the moderation endpoint on a harmless input; returns whether it was flagged. */
  async moderate(input: string, signal: AbortSignal): Promise<boolean> {
    const response = await this.fetchFn(`${OPENAI_API_URL}/moderations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: OPENAI_MODERATION_MODEL, input }),
      signal,
    });
    await assertOk(response, 'OpenAI moderation');
    const body = (await response.json()) as { results?: { flagged?: unknown }[] };
    const flagged = body.results?.[0]?.flagged;
    if (typeof flagged !== 'boolean') {
      throw new ProviderError('OpenAI moderation returned no result');
    }
    return flagged;
  }
}

interface GeminiPart {
  inlineData?: { mimeType?: unknown; data?: unknown };
}

interface GeminiResponse {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: unknown }[];
  promptFeedback?: { blockReason?: unknown };
}

/** Finish reasons Gemini uses when its safety filters stop an image. */
const GEMINI_SAFETY_REASONS = new Set([
  'SAFETY',
  'IMAGE_SAFETY',
  'PROHIBITED_CONTENT',
  'BLOCKLIST',
  'SPII',
]);

/** One Gemini image per call via `generateContent` on the Gemini API, with an API key. */
export class GeminiCheckProvider implements ImageProvider {
  constructor(
    private readonly apiKey: string,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  async generate(model: ModelConfig, req: ImageRequest): Promise<ImageResult> {
    const quality = model.qualities[req.quality];
    if (!quality) throw new ProviderError(`Model ${model.id} has no ${req.quality} quality`);
    const { providerSize } = mapAspect(model, req.aspect, req.quality);
    const calls = Array.from({ length: req.count }, () => this.call(model, req, providerSize));
    const results = await Promise.all(calls);
    return {
      images: await Promise.all(results.map((bytes) => normalisePng(bytes))),
      providerCostCents: quality.costPoints * results.length,
    };
  }

  edit(model: ModelConfig): Promise<ImageResult> {
    return unsupportedEdit(model);
  }

  private async call(
    model: ModelConfig,
    req: ImageRequest,
    aspectRatio: string,
  ): Promise<Uint8Array> {
    const imageSize = model.qualities[req.quality]?.providerParams.imageSize;
    const response = await this.fetchFn(
      `${GEMINI_API_URL}/models/${encodeURIComponent(model.providerModelId)}:generateContent`,
      {
        method: 'POST',
        headers: { 'x-goog-api-key': this.apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: req.prompt }] }],
          generationConfig: {
            responseModalities: ['IMAGE'],
            imageConfig: { aspectRatio, ...(imageSize ? { imageSize } : {}) },
          },
        }),
        signal: req.signal,
      },
    );
    await assertOk(response, 'Gemini');
    const body = (await response.json()) as GeminiResponse;
    const blockReason = body.promptFeedback?.blockReason;
    if (typeof blockReason === 'string') {
      throw new ProviderSafetyError(`Gemini blocked the prompt: ${blockReason}`);
    }
    const candidate = body.candidates?.[0];
    const finishReason = candidate?.finishReason;
    if (typeof finishReason === 'string' && GEMINI_SAFETY_REASONS.has(finishReason)) {
      throw new ProviderSafetyError(`Gemini stopped the image: ${finishReason}`);
    }
    const data = candidate?.content?.parts?.find(
      (part) => typeof part.inlineData?.data === 'string',
    )?.inlineData?.data;
    if (typeof data !== 'string' || data === '') {
      throw new ProviderError(
        `Model ${model.id} returned no image${typeof finishReason === 'string' ? ` (${finishReason})` : ''}`,
      );
    }
    return new Uint8Array(Buffer.from(data, 'base64'));
  }
}

export interface CheckResult {
  /** A model ID, or `openai-moderation` for the moderation call. */
  name: string;
  quality?: Quality;
  ok: boolean;
  /** `1024x1024` for images, `not flagged` for moderation, or the error message. */
  detail: string;
  ms: number;
  png?: Uint8Array;
}

export interface CheckDeps {
  adapters: Partial<Record<LiveProvider, ImageProvider>>;
  /** Present when OpenAI is checked: its moderation endpoint is checked too. */
  moderate?: (input: string, signal: AbortSignal) => Promise<boolean>;
  now?: () => number;
}

/** Runs one draft image per model, one after another, then the moderation call. Never throws. */
export async function runChecks(
  models: readonly ModelConfig[],
  deps: CheckDeps,
): Promise<CheckResult[]> {
  const now = deps.now ?? Date.now;
  const results: CheckResult[] = [];
  for (const model of models) {
    const quality = cheapestQuality(model);
    const adapter = deps.adapters[model.provider as LiveProvider];
    if (!adapter) {
      results.push({
        name: model.id,
        quality,
        ok: false,
        detail: `No adapter for ${model.provider}`,
        ms: 0,
      });
      continue;
    }
    results.push(await checkImage(model, quality, adapter, false, now));
    if (model.capabilities.transparentBackground) {
      results.push(await checkImage(model, quality, adapter, true, now));
    }
  }
  if (deps.moderate) {
    const started = now();
    try {
      const flagged = await deps.moderate(CHECK_PROMPT, providerSignal());
      results.push({
        name: 'openai-moderation',
        ok: !flagged,
        detail: flagged ? 'flagged a harmless prompt' : 'not flagged',
        ms: now() - started,
      });
    } catch (error) {
      results.push({
        name: 'openai-moderation',
        ok: false,
        detail: message(error),
        ms: now() - started,
      });
    }
  }
  return results;
}

/**
 * One draft image from the model. With `transparent`, it asks for a transparent background and fails unless
 * the PNG has an alpha channel; the result is named `<model>-transparent`.
 */
async function checkImage(
  model: ModelConfig,
  quality: Quality,
  adapter: ImageProvider,
  transparent: boolean,
  now: () => number,
): Promise<CheckResult> {
  const name = transparent ? `${model.id}-transparent` : model.id;
  const started = now();
  try {
    const result = await guardProvider(adapter).generate(model, {
      prompt: CHECK_PROMPT,
      aspect: '1:1',
      quality,
      count: 1,
      ...(transparent ? { transparentBackground: true } : {}),
      signal: providerSignal(),
    });
    const [image] = result.images;
    if (!image) throw new ProviderError(`Model ${model.id} returned no image`);
    if (transparent && !(await sharp(image.png).metadata()).hasAlpha) {
      throw new ProviderError('The transparent-background PNG has no alpha channel');
    }
    return {
      name,
      quality,
      ok: true,
      detail: `${image.width}x${image.height}${transparent ? ' with alpha' : ''}`,
      ms: now() - started,
      png: image.png,
    };
  } catch (error) {
    return { name, quality, ok: false, detail: message(error), ms: now() - started };
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A plain-text table of the results, one line per check. */
export function formatResults(results: readonly CheckResult[]): string {
  const rows = results.map((result) => ({
    padded: [
      result.ok ? 'PASS' : 'FAIL',
      result.name,
      result.quality ?? '',
      `${(result.ms / 1000).toFixed(1)}s`,
    ],
    detail: result.detail,
  }));
  const widths = rows.reduce<number[]>(
    (max, row) => row.padded.map((cell, column) => Math.max(max[column] ?? 0, cell.length)),
    [],
  );
  return rows
    .map((row) =>
      [...row.padded.map((cell, column) => cell.padEnd(widths[column] ?? 0)), row.detail]
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}
