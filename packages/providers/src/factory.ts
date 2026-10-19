import type { ModelConfig, Provider } from '@pictora/core';
import { BedrockProvider } from './bedrock.js';
import { ProviderError, toProviderError } from './errors.js';
import { MockProvider } from './mock.js';
import { withRetry, type RetryOptions } from './retry.js';
import type { ImageProvider, ImageRequest, ImageResult } from './types.js';

/** Builds the adapter for one provider. */
export type AdapterFactory = () => ImageProvider;

/**
 * The adapters that need no configuration. OpenAI needs its key's secret, so the worker adds it
 * (`OpenAiProvider`); Gemini joins in its own issue.
 */
export const DEFAULT_ADAPTERS: Partial<Record<Provider, AdapterFactory>> = {
  bedrock: () => new BedrockProvider(),
  mock: () => new MockProvider(),
};

export interface ProviderFactoryOptions {
  adapters?: Partial<Record<Provider, AdapterFactory>>;
  /** Retry settings apart from the signal, which comes from each request; for tests. */
  retry?: Omit<RetryOptions, 'signal'>;
}

/**
 * Returns a function that picks the adapter for a model from `ModelConfig.provider`. Each adapter is built
 * once, and wrapped so every call is retried once on transient errors and throws only typed provider errors.
 */
export function createProviderFactory(
  options: ProviderFactoryOptions = {},
): (model: ModelConfig) => ImageProvider {
  const adapters = options.adapters ?? DEFAULT_ADAPTERS;
  const built = new Map<Provider, ImageProvider>();

  return (model) => {
    let provider = built.get(model.provider);
    if (!provider) {
      const create = adapters[model.provider];
      if (!create) {
        throw new ProviderError(`No adapter for provider ${model.provider} (model ${model.id})`, {
          userMessage: 'This model is not available right now. Your points have been refunded.',
        });
      }
      provider = guardProvider(create(), options.retry);
      built.set(model.provider, provider);
    }
    return provider;
  };
}

/** Wraps an adapter with one retry on transient errors and the mapping to typed errors. */
export function guardProvider(
  adapter: ImageProvider,
  retry: Omit<RetryOptions, 'signal'> = {},
): ImageProvider {
  const call = async (run: () => Promise<ImageResult>, req: ImageRequest): Promise<ImageResult> => {
    try {
      return await withRetry(run, { ...retry, signal: req.signal });
    } catch (error) {
      throw toProviderError(error);
    }
  };
  return {
    generate: (model, req) => call(() => adapter.generate(model, req), req),
    edit: (model, req) => call(() => adapter.edit(model, req), req),
  };
}
