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
import { ProviderError } from '../src/errors.js';
import { guardProvider } from '../src/factory.js';
import { normalisePng } from '../src/image.js';
import { providerSignal } from '../src/retry.js';
import type { ImageProvider, ImageRequest, ImageResult } from '../src/types.js';

/**
 * The live provider check (tech design 13): one draft image per enabled model with real credentials, run by
 * hand on a laptop before a prod release. Never run in CI. Gemini and Bedrock go through their adapters; OpenAI
 * is called through the small client below until its adapter (#14) exists.
 */

export const CHECK_PROMPT = 'A red apple on a wooden table, soft daylight';
export const OPENAI_API_URL = 'https://api.openai.com/v1';
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

/** One OpenAI image per call via `POST /v1/images/generations`; GPT Image models return base64 PNGs. */
export class OpenAiCheckProvider implements ImageProvider {
  constructor(
    private readonly apiKey: string,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  async generate(model: ModelConfig, req: ImageRequest): Promise<ImageResult> {
    const quality = model.qualities[req.quality];
    if (!quality) throw new ProviderError(`Model ${model.id} has no ${req.quality} quality`);
    const { generated } = mapAspect(model, req.aspect, req.quality);
    const response = await this.fetchFn(`${OPENAI_API_URL}/images/generations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: model.providerModelId,
        prompt: req.prompt,
        size: `${generated.width}x${generated.height}`,
        n: req.count,
        output_format: 'png',
        ...quality.providerParams,
      }),
      signal: req.signal,
    });
    await assertOk(response, 'OpenAI');
    const body = (await response.json()) as { data?: { b64_json?: unknown }[] };
    const encoded = (body.data ?? [])
      .map((item) => item.b64_json)
      .filter((value): value is string => typeof value === 'string' && value !== '');
    if (encoded.length === 0) throw new ProviderError(`Model ${model.id} returned no image`);
    const images = await Promise.all(
      encoded.map((value) => normalisePng(new Uint8Array(Buffer.from(value, 'base64')))),
    );
    return {
      images,
      providerRequestId: response.headers.get('x-request-id') ?? undefined,
      providerCostCents: quality.costPoints * images.length,
    };
  }

  edit(model: ModelConfig): Promise<ImageResult> {
    return unsupportedEdit(model);
  }

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
    const started = now();
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
    try {
      const result = await guardProvider(adapter).generate(model, {
        prompt: CHECK_PROMPT,
        aspect: '1:1',
        quality,
        count: 1,
        signal: providerSignal(),
      });
      const [image] = result.images;
      if (!image) throw new ProviderError(`Model ${model.id} returned no image`);
      results.push({
        name: model.id,
        quality,
        ok: true,
        detail: `${image.width}x${image.height}`,
        ms: now() - started,
        png: image.png,
      });
    } catch (error) {
      results.push({
        name: model.id,
        quality,
        ok: false,
        detail: message(error),
        ms: now() - started,
      });
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
