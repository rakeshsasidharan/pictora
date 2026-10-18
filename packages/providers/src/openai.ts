import {
  MAX_IMAGE_COUNT,
  MIN_IMAGE_COUNT,
  mapAspect,
  type ModelConfig,
  type Quality,
} from '@pictora/core';
import OpenAI, { APIConnectionError, APIConnectionTimeoutError, APIError, toFile } from 'openai';
import type { ImageEditParamsNonStreaming, ImagesResponse } from 'openai/resources/images';
import {
  ProviderError,
  ProviderSafetyError,
  ProviderTimeoutError,
  toProviderError,
} from './errors.js';
import { centreCrop, isPng, normalisePng } from './image.js';
import { PROVIDER_TIMEOUT_MS } from './retry.js';
import type { GeneratedImage, ImageProvider, ImageRequest, ImageResult } from './types.js';

/** US dollars per million tokens, by `providerModelId`. Check against OpenAI's pricing page on a price change. */
export interface OpenAiTokenPrices {
  textInput: number;
  imageInput: number;
  imageOutput: number;
  /** Text output tokens, when a model reports any. */
  textOutput: number;
}

export const OPENAI_TOKEN_PRICES: Readonly<Record<string, OpenAiTokenPrices>> = {
  'gpt-image-2': { textInput: 5, imageInput: 8, imageOutput: 30, textOutput: 10 },
  'gpt-image-1-mini': { textInput: 2, imageInput: 2.5, imageOutput: 8, textOutput: 8 },
};

/** Edits take the parent image plus up to 3 references (EDIT-5). */
export const OPENAI_MAX_REFERENCE_IMAGES = 3;

/** Error codes OpenAI uses when its safety system rejects a prompt or image. */
const SAFETY_CODES = new Set(['moderation_blocked', 'content_policy_violation']);
const SAFETY_PATTERN = /safety system|content policy|moderation_blocked/i;

export interface OpenAiProviderOptions {
  /** The API key, read from Secrets Manager `pictora/<env>/openai` in a deployed worker. */
  apiKey: () => Promise<string>;
  /** For tests. */
  baseURL?: string;
  prices?: Readonly<Record<string, OpenAiTokenPrices>>;
}

/**
 * GPT Image 2 and GPT Image 1 Mini through the `openai` SDK. Generate calls `images.generate`, edit calls
 * `images.edit` with the parent PNG first and the references after it. Aspects with no native OpenAI size are
 * generated at the nearest size and centre-cropped (GEN-3). The SDK's own retries are off: the factory wrapper
 * retries once.
 */
export class OpenAiProvider implements ImageProvider {
  private readonly prices: Readonly<Record<string, OpenAiTokenPrices>>;
  private client?: { key: string; sdk: OpenAI };

  constructor(private readonly options: OpenAiProviderOptions) {
    this.prices = options.prices ?? OPENAI_TOKEN_PRICES;
  }

  async generate(model: ModelConfig, req: ImageRequest): Promise<ImageResult> {
    if (!model.capabilities.generate) {
      throw new ProviderError(`Model ${model.id} does not support generate`);
    }
    const params = this.baseParams(model, req);
    const sdk = await this.sdk();
    return this.call(model, req, () =>
      sdk.images.generate(params, { signal: req.signal }).withResponse(),
    );
  }

  async edit(model: ModelConfig, req: ImageRequest): Promise<ImageResult> {
    if (!model.capabilities.edit) {
      throw new ProviderError(`Model ${model.id} does not support edit`, {
        userMessage: 'This model can’t edit images. Your points have been refunded.',
      });
    }
    if (!req.inputImage) throw new ProviderError(`An edit with model ${model.id} needs an image`);
    const references = req.referenceImages ?? [];
    const maxReferences = Math.min(model.capabilities.referenceImages, OPENAI_MAX_REFERENCE_IMAGES);
    if (references.length > maxReferences) {
      throw new ProviderError(
        `Model ${model.id} takes at most ${maxReferences} reference images: ${references.length}`,
      );
    }
    const params = this.baseParams(model, req);
    const images = await Promise.all(
      [req.inputImage, ...references].map((bytes, index) => {
        const type = imageType(bytes);
        const name = index === 0 ? 'image' : `reference-${index}`;
        return toFile(bytes, `${name}.${type.slice('image/'.length)}`, { type });
      }),
    );
    const body: ImageEditParamsNonStreaming = { ...params, image: images };
    const sdk = await this.sdk();
    return this.call(model, req, () =>
      sdk.images.edit(body, { signal: req.signal }).withResponse(),
    );
  }

  /** The fields generate and edit share. */
  private baseParams(model: ModelConfig, req: ImageRequest) {
    if (
      !Number.isInteger(req.count) ||
      req.count < MIN_IMAGE_COUNT ||
      req.count > MAX_IMAGE_COUNT
    ) {
      throw new ProviderError(
        `Image count must be ${MIN_IMAGE_COUNT}–${MAX_IMAGE_COUNT}: ${req.count}`,
      );
    }
    if (!model.qualities[req.quality]) {
      throw new ProviderError(`Model ${model.id} has no ${req.quality} quality`);
    }
    return openAiRequestParams(model, req);
  }

  private async call(
    model: ModelConfig,
    req: ImageRequest,
    run: () => Promise<{ data: ImagesResponse; request_id: string | null }>,
  ): Promise<ImageResult> {
    let data: ImagesResponse;
    let requestId: string | null;
    try {
      ({ data, request_id: requestId } = await run());
    } catch (error) {
      if (req.signal.aborted) {
        throw new ProviderTimeoutError('Provider call aborted or timed out', { cause: error });
      }
      throw toOpenAiError(error);
    }

    const encoded = (data.data ?? [])
      .map((item) => item.b64_json)
      .filter((value): value is string => typeof value === 'string' && value !== '');
    if (encoded.length === 0) throw new ProviderError(`Model ${model.id} returned no image`);

    const { crop } = mapAspect(model, req.aspect, req.quality);
    const images: GeneratedImage[] = await Promise.all(
      encoded.map(async (value) => {
        const bytes = new Uint8Array(Buffer.from(value, 'base64'));
        return crop ? centreCrop(bytes, req.aspect) : normalisePng(bytes);
      }),
    );
    return {
      images,
      providerRequestId: requestId ?? undefined,
      providerCostCents: openAiCostCents(
        model,
        req.quality,
        data.usage,
        images.length,
        this.prices,
      ),
    };
  }

  /** One SDK client per key, rebuilt when the cached secret changes. */
  private async sdk(): Promise<OpenAI> {
    let key: string;
    try {
      key = await this.options.apiKey();
    } catch (error) {
      throw new ProviderError('The OpenAI API key could not be read', { cause: error });
    }
    if (this.client?.key !== key) {
      this.client = {
        key,
        sdk: new OpenAI({
          apiKey: key,
          baseURL: this.options.baseURL,
          maxRetries: 0,
          timeout: PROVIDER_TIMEOUT_MS,
        }),
      };
    }
    return this.client.sdk;
  }
}

/** The request fields for a generate or edit: model, prompt, PNG output, quality, size, count and background. */
export function openAiRequestParams(model: ModelConfig, req: ImageRequest) {
  const quality = model.qualities[req.quality]?.providerParams.quality;
  if (typeof quality !== 'string') {
    throw new ProviderError(`Model ${model.id} quality ${req.quality} has no OpenAI quality`);
  }
  return {
    model: model.providerModelId,
    prompt: req.prompt,
    output_format: 'png' as const,
    quality: quality as 'low' | 'medium' | 'high',
    size: mapAspect(model, req.aspect, req.quality).providerSize,
    n: req.count,
    ...(req.transparentBackground && model.capabilities.transparentBackground
      ? { background: 'transparent' as const }
      : {}),
  };
}

/**
 * The cost of a call in cents, from the response's token usage at the model's token prices. Without usage
 * data, or for a model with no prices, it falls back to the registry estimate: the quality's points per image.
 */
export function openAiCostCents(
  model: ModelConfig,
  quality: Quality,
  usage: ImagesResponse.Usage | undefined,
  imageCount: number,
  prices: Readonly<Record<string, OpenAiTokenPrices>> = OPENAI_TOKEN_PRICES,
): number {
  const price = prices[model.providerModelId];
  if (!price || !usage || typeof usage.input_tokens !== 'number') {
    const costPoints = model.qualities[quality]?.costPoints ?? 0;
    return costPoints * imageCount;
  }
  const textInput = usage.input_tokens_details?.text_tokens ?? usage.input_tokens;
  const imageInput = usage.input_tokens_details?.image_tokens ?? 0;
  const imageOutput = usage.output_tokens_details?.image_tokens ?? usage.output_tokens ?? 0;
  const textOutput = usage.output_tokens_details?.text_tokens ?? 0;
  const dollars =
    (textInput * price.textInput +
      imageInput * price.imageInput +
      imageOutput * price.imageOutput +
      textOutput * price.textOutput) /
    1_000_000;
  // Hundredths of a cent are plenty, and keep float noise out of the spend counters.
  return Math.round(dollars * 100 * 100) / 100;
}

/** Maps an OpenAI SDK error to a typed provider error; a safety refusal becomes `ProviderSafetyError`. */
export function toOpenAiError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof APIError) {
    const message = error.message;
    if (
      (error.status === 400 || error.status === undefined) &&
      ((error.code && SAFETY_CODES.has(error.code)) || SAFETY_PATTERN.test(message))
    ) {
      return new ProviderSafetyError(message, { status: error.status, cause: error });
    }
    if (error instanceof APIConnectionTimeoutError) {
      return new ProviderTimeoutError(message, { cause: error });
    }
    if (error instanceof APIConnectionError) {
      return new ProviderError(message, { retryable: true, cause: error });
    }
  }
  return toProviderError(error);
}

function imageType(bytes: Uint8Array): string {
  if (isPng(bytes)) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  return 'image/webp';
}
