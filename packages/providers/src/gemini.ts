import { GoogleGenAI, type GenerateContentResponse, type GoogleGenAIOptions } from '@google/genai';
import { MAX_IMAGE_COUNT, MIN_IMAGE_COUNT, mapAspect, type ModelConfig } from '@pictora/core';
import {
  ProviderError,
  ProviderSafetyError,
  ProviderTimeoutError,
  toProviderError,
} from './errors.js';
import { isPng, normalisePng } from './image.js';
import { PROVIDER_TIMEOUT_MS } from './retry.js';
import type { GeneratedImage, ImageProvider, ImageRequest, ImageResult } from './types.js';

/** Where Gemini runs: the Gemini API with an API key, or Vertex AI with a service account (tech design 6.2). */
export const GEMINI_BACKENDS = ['api', 'vertex'] as const;
export type GeminiBackend = (typeof GEMINI_BACKENDS)[number];

/** Vertex AI's location when none is configured; the Gemini image models are served from `global`. */
export const GEMINI_DEFAULT_VERTEX_LOCATION = 'global';

/** Edits take the parent image plus up to 3 references (EDIT-5). */
export const GEMINI_MAX_REFERENCE_IMAGES = 3;

/** Finish and block reasons Gemini uses when its safety filters stop a request or an image. */
const SAFETY_REASONS = new Set([
  'SAFETY',
  'IMAGE_SAFETY',
  'PROHIBITED_CONTENT',
  'IMAGE_PROHIBITED_CONTENT',
  'BLOCKLIST',
  'SPII',
  'MODEL_ARMOR',
]);

export interface GeminiConfig {
  backend: GeminiBackend;
  /** Vertex AI only: the Google Cloud project. Defaults to the service account's `project_id`. */
  project?: string;
  /** Vertex AI only. */
  location?: string;
}

export interface GeminiProviderOptions {
  config: GeminiConfig;
  /**
   * The secret's contents from Secrets Manager `pictora/<env>/gemini`: the API key for the Gemini API, or the
   * service account key JSON for Vertex AI.
   */
  credential: () => Promise<string>;
  /** For tests: the Gemini API base URL. */
  baseUrl?: string;
}

/**
 * Reads the Gemini backend from `GEMINI_BACKEND` (`api` when unset), with `GEMINI_VERTEX_PROJECT` and
 * `GEMINI_VERTEX_LOCATION` for Vertex AI. Throws on an unknown backend.
 */
export function geminiConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GeminiConfig {
  const backend = env.GEMINI_BACKEND?.trim() || 'api';
  if (!(GEMINI_BACKENDS as readonly string[]).includes(backend)) {
    throw new Error(`GEMINI_BACKEND must be one of ${GEMINI_BACKENDS.join(', ')}: ${backend}`);
  }
  if (backend === 'api') return { backend: 'api' };
  return {
    backend: 'vertex',
    project: env.GEMINI_VERTEX_PROJECT?.trim() || undefined,
    location: env.GEMINI_VERTEX_LOCATION?.trim() || GEMINI_DEFAULT_VERTEX_LOCATION,
  };
}

/**
 * The SDK client options for a backend and the secret's contents. The same `@google/genai` calls work on both,
 * so switching backends is config and secret only.
 */
export function geminiClientOptions(
  config: GeminiConfig,
  credential: string,
  baseUrl?: string,
): GoogleGenAIOptions {
  const httpOptions = {
    timeout: PROVIDER_TIMEOUT_MS,
    // The factory wrapper retries once; the SDK must not retry as well.
    retryOptions: { attempts: 1 },
    ...(baseUrl ? { baseUrl } : {}),
  };
  const secret = credential.trim();
  if (!secret) throw new ProviderError('The Gemini secret is empty');
  if (config.backend === 'api') return { apiKey: secret, httpOptions };

  let credentials: Record<string, unknown>;
  try {
    credentials = JSON.parse(secret) as Record<string, unknown>;
  } catch (error) {
    throw new ProviderError(
      'The Gemini secret must hold a service account key JSON for Vertex AI',
      {
        cause: error,
      },
    );
  }
  const project =
    config.project ??
    (typeof credentials.project_id === 'string' ? credentials.project_id : undefined);
  if (!project) throw new ProviderError('Vertex AI needs a project: set GEMINI_VERTEX_PROJECT');
  return {
    vertexai: true,
    project,
    location: config.location ?? GEMINI_DEFAULT_VERTEX_LOCATION,
    googleAuthOptions: {
      credentials,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    },
    httpOptions,
  };
}

/**
 * Gemini 3.1 Flash Image, 3.1 Flash Lite Image and 3 Pro Image through `models.generateContent`. Each call
 * returns one image, so `count` images are parallel calls; when only some succeed, only those are returned and
 * charged. Edits are stateless: the parent image, any references and the instruction go in one call, with no
 * chat history.
 */
export class GeminiProvider implements ImageProvider {
  private client?: { credential: string; sdk: GoogleGenAI };

  constructor(private readonly options: GeminiProviderOptions) {}

  async generate(model: ModelConfig, req: ImageRequest): Promise<ImageResult> {
    if (!model.capabilities.generate) {
      throw new ProviderError(`Model ${model.id} does not support generate`);
    }
    return this.run(model, req, []);
  }

  async edit(model: ModelConfig, req: ImageRequest): Promise<ImageResult> {
    if (!model.capabilities.edit) {
      throw new ProviderError(`Model ${model.id} does not support edit`, {
        userMessage: 'This model can’t edit images. Your points have been refunded.',
      });
    }
    if (!req.inputImage) throw new ProviderError(`An edit with model ${model.id} needs an image`);
    const references = req.referenceImages ?? [];
    const maxReferences = Math.min(model.capabilities.referenceImages, GEMINI_MAX_REFERENCE_IMAGES);
    if (references.length > maxReferences) {
      throw new ProviderError(
        `Model ${model.id} takes at most ${maxReferences} reference images: ${references.length}`,
      );
    }
    return this.run(model, req, [req.inputImage, ...references]);
  }

  private async run(
    model: ModelConfig,
    req: ImageRequest,
    images: Uint8Array[],
  ): Promise<ImageResult> {
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
    const request = geminiRequest(model, req, images);
    const sdk = await this.sdk();

    const settled = await Promise.allSettled(
      Array.from({ length: req.count }, () => this.call(sdk, model, request, req.signal)),
    );
    const results: GeneratedImage[] = [];
    const requestIds: string[] = [];
    const errors: ProviderError[] = [];
    for (const outcome of settled) {
      if (outcome.status === 'fulfilled') {
        results.push(outcome.value.image);
        if (outcome.value.requestId) requestIds.push(outcome.value.requestId);
      } else {
        errors.push(
          req.signal.aborted
            ? new ProviderTimeoutError('Provider call aborted or timed out', {
                cause: outcome.reason,
              })
            : toGeminiError(outcome.reason),
        );
      }
    }
    if (results.length === 0) {
      // A safety refusal decides the job's state, so it wins over other failures.
      throw errors.find((error) => error instanceof ProviderSafetyError) ?? errors[0];
    }
    return {
      images: results,
      providerRequestId: requestIds.length > 0 ? requestIds.join(',') : undefined,
      providerCostCents: quality.costPoints * results.length,
    };
  }

  private async call(
    sdk: GoogleGenAI,
    model: ModelConfig,
    request: GeminiRequest,
    signal: AbortSignal,
  ): Promise<{ image: GeneratedImage; requestId?: string }> {
    const response = await sdk.models.generateContent({
      ...request,
      config: { ...request.config, abortSignal: signal },
    });
    const bytes = imageFromResponse(model, response);
    return { image: await normalisePng(bytes), requestId: response.responseId };
  }

  /** One SDK client per credential, rebuilt when the cached secret changes. */
  private async sdk(): Promise<GoogleGenAI> {
    let credential: string;
    try {
      credential = await this.options.credential();
    } catch (error) {
      throw new ProviderError('The Gemini credentials could not be read', { cause: error });
    }
    if (this.client?.credential !== credential) {
      this.client = {
        credential,
        sdk: new GoogleGenAI(
          geminiClientOptions(this.options.config, credential, this.options.baseUrl),
        ),
      };
    }
    return this.client.sdk;
  }
}

/** The `generateContent` parameters for one image, without the abort signal. */
export interface GeminiRequest {
  model: string;
  contents: {
    role: 'user';
    parts: ({ inlineData: { mimeType: string; data: string } } | { text: string })[];
  }[];
  config: {
    responseModalities: ['IMAGE'];
    imageConfig: { aspectRatio: string; imageSize?: string };
  };
}

/**
 * The request for a generate (no images) or an edit (the parent image, then the references): the images as
 * inline data followed by the prompt, an image-only response, the aspect ratio and the quality's size tier.
 */
export function geminiRequest(
  model: ModelConfig,
  req: ImageRequest,
  images: readonly Uint8Array[] = [],
): GeminiRequest {
  const quality = model.qualities[req.quality];
  if (!quality) throw new ProviderError(`Model ${model.id} has no ${req.quality} quality`);
  const imageSize = quality.providerParams.imageSize;
  return {
    model: model.providerModelId,
    contents: [
      {
        role: 'user',
        parts: [
          ...images.map((bytes) => ({
            inlineData: { mimeType: imageType(bytes), data: Buffer.from(bytes).toString('base64') },
          })),
          { text: req.prompt },
        ],
      },
    ],
    config: {
      responseModalities: ['IMAGE'],
      imageConfig: {
        aspectRatio: mapAspect(model, req.aspect, req.quality).providerSize,
        ...(typeof imageSize === 'string' ? { imageSize } : {}),
      },
    },
  };
}

/** The first image in a response; a safety block or a safety finish reason throws `ProviderSafetyError`. */
function imageFromResponse(model: ModelConfig, response: GenerateContentResponse): Uint8Array {
  const blockReason = response.promptFeedback?.blockReason;
  if (blockReason) {
    if (SAFETY_REASONS.has(blockReason) || blockReason === 'OTHER') {
      throw new ProviderSafetyError(`Gemini blocked the prompt: ${blockReason}`);
    }
    throw new ProviderError(`Gemini blocked the prompt: ${blockReason}`);
  }
  const candidate = response.candidates?.[0];
  const finishReason = candidate?.finishReason;
  if (finishReason && SAFETY_REASONS.has(finishReason)) {
    throw new ProviderSafetyError(`Gemini stopped the image: ${finishReason}`);
  }
  const blocked = candidate?.safetyRatings?.find((rating) => rating.blocked);
  if (blocked) {
    throw new ProviderSafetyError(`Gemini blocked the image: ${blocked.category ?? 'safety'}`);
  }
  const data = candidate?.content?.parts?.find(
    (part) => typeof part.inlineData?.data === 'string' && part.inlineData.data !== '',
  )?.inlineData?.data;
  if (!data) {
    throw new ProviderError(
      `Model ${model.id} returned no image${finishReason ? ` (${finishReason})` : ''}`,
    );
  }
  return new Uint8Array(Buffer.from(data, 'base64'));
}

/** Maps a `@google/genai` error to a typed provider error. */
export function toGeminiError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const status = (error as { status?: unknown } | undefined)?.status;
  // Gemini rejects some unsafe inputs, such as images, with a 400 that names the safety filter.
  if (status === 400 && /safety|prohibited|blocked/i.test(message)) {
    return new ProviderSafetyError(message, { status, cause: error });
  }
  return toProviderError(error);
}

function imageType(bytes: Uint8Array): string {
  if (isPng(bytes)) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  return 'image/webp';
}
