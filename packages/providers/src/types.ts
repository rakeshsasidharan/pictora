import type { Aspect, ModelConfig, Quality } from '@pictora/core';

/** One generate or edit call to a provider (tech design 6.2). */
export interface ImageRequest {
  /** Final prompt (enhanced or raw); the edit instruction for edits. */
  prompt: string;
  negativePrompt?: string;
  aspect: Aspect;
  quality: Quality;
  /** 1–4. */
  count: number;
  seed?: number;
  transparentBackground?: boolean;
  /** The parent version's PNG, for edits. */
  inputImage?: Uint8Array;
  referenceImages?: Uint8Array[];
  /** Aborts the call; the worker gives each call 120 s. */
  signal: AbortSignal;
}

export interface GeneratedImage {
  png: Uint8Array;
  width: number;
  height: number;
  seed?: number;
}

export interface ImageResult {
  images: GeneratedImage[];
  providerRequestId?: string;
  /** Computed from the provider's usage data when available, otherwise from list price. */
  providerCostCents: number;
}

/**
 * A provider adapter. Adapters return PNGs only, and throw only the typed errors in `errors.ts`.
 */
export interface ImageProvider {
  generate(model: ModelConfig, req: ImageRequest): Promise<ImageResult>;
  edit(model: ModelConfig, req: ImageRequest): Promise<ImageResult>;
}
