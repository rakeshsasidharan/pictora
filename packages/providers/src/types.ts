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

/** What a provider batch request carries for one job: a generate request without its abort signal. */
export type BatchImageRequest = Omit<ImageRequest, 'signal' | 'inputImage' | 'referenceImages'>;

/** One job in a provider batch (tech design 5.4): its key, the job ID, and its request. */
export interface BatchItem {
  key: string;
  request: BatchImageRequest;
}

/** What a finished batch returned for one job: its images and their cost, or why it made none. */
export interface BatchItemResult {
  images: GeneratedImage[];
  /** Batch price: half of list price, from usage data where the provider reports it. */
  providerCostCents: number;
  /** Set when the job made no images; a `ProviderSafetyError` blocks it. */
  error?: Error;
}

/**
 * A provider batch's state. `pending` while it runs. `done` once it finished, expired or was cancelled, with the
 * result of every job it has one for (`expired` when the provider's window ran out first). `failed` when the
 * whole batch failed and no job has a result.
 */
export type BatchPoll =
  | { state: 'pending' }
  | { state: 'done'; expired: boolean; results: Map<string, BatchItemResult> }
  | { state: 'failed'; error: Error };

/** An adapter that takes batch jobs through the provider's batch API (P1, tech design 5.4). */
export interface BatchImageProvider {
  /** Sends the items as one provider batch and returns the provider's batch ID. */
  submitBatch(
    model: ModelConfig,
    items: readonly BatchItem[],
    signal: AbortSignal,
  ): Promise<string>;
  /** Reads a batch's state; `items` are the jobs it was sent, for the mock and for results without keys. */
  pollBatch(
    model: ModelConfig,
    batchId: string,
    items: readonly BatchItem[],
    signal: AbortSignal,
  ): Promise<BatchPoll>;
}

/** The batch price is half of list price on every provider with a batch API. */
export const BATCH_PRICE_FACTOR = 0.5;
