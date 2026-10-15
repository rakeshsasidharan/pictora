import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { MAX_IMAGE_COUNT, MIN_IMAGE_COUNT, mapAspect, type ModelConfig } from '@pictora/core';
import {
  ProviderError,
  ProviderRateLimitError,
  ProviderSafetyError,
  toProviderError,
} from './errors.js';
import { normalisePng } from './image.js';
import type { GeneratedImage, ImageProvider, ImageRequest, ImageResult } from './types.js';

/** Bedrock image models run on demand in us-west-2 only (PRD registry rules). */
export const BEDROCK_REGION = 'us-west-2';

/** Stability accepts seeds from 0 to 4,294,967,294; 0 means random. */
export const STABILITY_MAX_SEED = 4_294_967_294;

/** The JSON body of a Stability text-to-image `InvokeModel` call on Bedrock. */
export interface StabilityRequestBody {
  prompt: string;
  /** SD 3.5 Large takes a mode; Stable Image Core and Ultra are text-to-image only and take none. */
  mode?: 'text-to-image';
  aspect_ratio: string;
  output_format: 'png';
  negative_prompt?: string;
  seed?: number;
}

/** The JSON body Stability models return: one base64 image per call. */
interface StabilityResponseBody {
  images?: unknown;
  seeds?: unknown;
  finish_reasons?: unknown;
}

/** Bedrock exceptions mapped by name, since they don't always carry an HTTP status. */
const RETRYABLE_EXCEPTIONS = new Set([
  'InternalServerException',
  'ServiceUnavailableException',
  'ModelNotReadyException',
  'ModelTimeoutException',
]);
const RATE_LIMIT_EXCEPTIONS = new Set(['ThrottlingException', 'ServiceQuotaExceededException']);

/** Wording Stability uses when its own content filter rejects a request outright. */
const CONTENT_FILTER_PATTERN = /content (filter|moderation)|filtered|flagged/i;

export interface BedrockProviderOptions {
  client?: BedrockRuntimeClient;
}

/**
 * Stability AI's Stable Image Core, SD 3.5 Large and Stable Image Ultra on Amazon Bedrock (P1). Calls
 * `InvokeModel` in us-west-2 with the worker's IAM role, so there is no key. Each call returns one image, so
 * `count` images are generated in parallel calls; when only some succeed, only those are returned and charged.
 * These models only generate; editing on Bedrock goes through the image tools (#35).
 */
export class BedrockProvider implements ImageProvider {
  private readonly client: BedrockRuntimeClient;

  constructor(options: BedrockProviderOptions = {}) {
    this.client = options.client ?? new BedrockRuntimeClient({ region: BEDROCK_REGION });
  }

  async generate(model: ModelConfig, req: ImageRequest): Promise<ImageResult> {
    if (!model.capabilities.generate) {
      throw new ProviderError(`Model ${model.id} does not support generate`);
    }
    if (
      !Number.isInteger(req.count) ||
      req.count < MIN_IMAGE_COUNT ||
      req.count > MAX_IMAGE_COUNT
    ) {
      throw new ProviderError(
        `Image count must be ${MIN_IMAGE_COUNT}–${MAX_IMAGE_COUNT}: ${req.count}`,
      );
    }
    const quality = model.qualities[req.quality];
    if (!quality) throw new ProviderError(`Model ${model.id} has no ${req.quality} quality`);

    const calls = Array.from({ length: req.count }, (_, index) =>
      this.invoke(model, stabilityRequestBody(model, req, index), req.signal),
    );
    const settled = await Promise.allSettled(calls);
    const images: GeneratedImage[] = [];
    const requestIds: string[] = [];
    const errors: ProviderError[] = [];
    for (const outcome of settled) {
      if (outcome.status === 'fulfilled') {
        images.push(outcome.value.image);
        if (outcome.value.requestId) requestIds.push(outcome.value.requestId);
      } else {
        errors.push(toBedrockError(outcome.reason));
      }
    }
    if (images.length === 0) {
      // A safety refusal decides the job's state, so it wins over other failures.
      throw errors.find((error) => error instanceof ProviderSafetyError) ?? errors[0];
    }
    return {
      images,
      providerRequestId: requestIds.length > 0 ? requestIds.join(',') : undefined,
      providerCostCents: quality.costPoints * images.length,
    };
  }

  edit(model: ModelConfig): Promise<ImageResult> {
    return Promise.reject(
      new ProviderError(`Model ${model.id} does not support edit`, {
        userMessage: 'This model can’t edit images. Your points have been refunded.',
      }),
    );
  }

  private async invoke(
    model: ModelConfig,
    body: StabilityRequestBody,
    signal: AbortSignal,
  ): Promise<{ image: GeneratedImage; requestId?: string }> {
    const response = await this.client.send(
      new InvokeModelCommand({
        modelId: model.providerModelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify(body),
      }),
      { abortSignal: signal },
    );
    const parsed = parseResponse(response.body);
    const reason = filterReason(parsed);
    if (reason) throw new ProviderSafetyError(`Stability content filter: ${reason}`);
    const [encoded] = Array.isArray(parsed.images) ? parsed.images : [];
    if (typeof encoded !== 'string' || encoded === '') {
      throw new ProviderError(`Model ${model.id} returned no image`);
    }
    const { png, width, height } = await normalisePng(
      new Uint8Array(Buffer.from(encoded, 'base64')),
    );
    const [seed] = Array.isArray(parsed.seeds) ? parsed.seeds : [];
    return {
      image: { png, width, height, ...(typeof seed === 'number' ? { seed } : {}) },
      requestId: response.$metadata.requestId,
    };
  }
}

/**
 * The request body for one image. With a seed, image `index` uses `seed + index`, so a batch is reproducible
 * and its images differ.
 */
export function stabilityRequestBody(
  model: ModelConfig,
  req: ImageRequest,
  index = 0,
): StabilityRequestBody {
  const body: StabilityRequestBody = {
    prompt: req.prompt,
    ...(model.providerModelId.startsWith('stability.sd3')
      ? { mode: 'text-to-image' as const }
      : {}),
    aspect_ratio: mapAspect(model, req.aspect, req.quality).providerSize,
    output_format: 'png',
  };
  const negative = req.negativePrompt?.trim();
  if (negative && model.capabilities.negativePrompt) body.negative_prompt = negative;
  if (req.seed !== undefined && model.capabilities.seed) {
    body.seed = (req.seed + index) % (STABILITY_MAX_SEED + 1);
  }
  return body;
}

function parseResponse(body: Uint8Array | undefined): StabilityResponseBody {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    if (typeof parsed === 'object' && parsed !== null) return parsed as StabilityResponseBody;
  } catch {
    // Reported below.
  }
  throw new ProviderError('Bedrock returned a response that is not JSON');
}

/** The content-filter reason in `finish_reasons`, if the model filtered the image. */
function filterReason(parsed: StabilityResponseBody): string | undefined {
  const reasons = Array.isArray(parsed.finish_reasons) ? parsed.finish_reasons : [];
  return reasons.find((value): value is string => typeof value === 'string' && value !== '');
}

/** Maps a Bedrock SDK error to a typed provider error. */
export function toBedrockError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  const name =
    typeof error === 'object' && error !== null && 'name' in error
      ? String((error as { name: unknown }).name)
      : '';
  const message = error instanceof Error ? error.message : String(error);
  if (RATE_LIMIT_EXCEPTIONS.has(name)) return new ProviderRateLimitError(message, { cause: error });
  if (RETRYABLE_EXCEPTIONS.has(name)) {
    return new ProviderError(message, { retryable: true, cause: error });
  }
  if (name === 'ValidationException') {
    if (CONTENT_FILTER_PATTERN.test(message)) {
      return new ProviderSafetyError(message, { status: 400, cause: error });
    }
    return new ProviderError(message, { status: 400, cause: error });
  }
  return toProviderError(error);
}
