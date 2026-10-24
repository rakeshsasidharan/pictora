import type { ModelConfig, Provider } from '@pictora/core';
import { ProviderError, toProviderError } from './errors.js';
import type { AdapterFactory } from './factory.js';
import { withRetry, type RetryOptions } from './retry.js';
import type { BatchImageProvider, ImageProvider } from './types.js';

/** True when an adapter also takes batch jobs. */
export function isBatchProvider(
  adapter: ImageProvider | (ImageProvider & BatchImageProvider),
): adapter is ImageProvider & BatchImageProvider {
  return (
    typeof (adapter as Partial<BatchImageProvider>).submitBatch === 'function' &&
    typeof (adapter as Partial<BatchImageProvider>).pollBatch === 'function'
  );
}

/**
 * Returns a function that picks the batch adapter for a model, as `createProviderFactory` does for single calls.
 * Each adapter is built once. Errors come back as typed provider errors. Reading a batch is retried once on a
 * transient error; submitting is never retried, since a retry after a lost answer could start a second batch.
 */
export function createBatchProviderFactory(
  adapters: Partial<Record<Provider, AdapterFactory>>,
  retry: Omit<RetryOptions, 'signal'> = {},
): (model: ModelConfig) => BatchImageProvider {
  const built = new Map<Provider, BatchImageProvider>();
  return (model) => {
    let provider = built.get(model.provider);
    if (!provider) {
      const create = adapters[model.provider];
      const adapter = create?.();
      if (!adapter || !isBatchProvider(adapter)) {
        throw new ProviderError(
          `No batch adapter for provider ${model.provider} (model ${model.id})`,
        );
      }
      provider = {
        submitBatch: async (batchModel, items, signal) => {
          try {
            return await adapter.submitBatch(batchModel, items, signal);
          } catch (error) {
            throw toProviderError(error);
          }
        },
        pollBatch: async (batchModel, batchId, items, signal) => {
          try {
            return await withRetry(() => adapter.pollBatch(batchModel, batchId, items, signal), {
              ...retry,
              signal,
            });
          } catch (error) {
            throw toProviderError(error);
          }
        },
      };
      built.set(model.provider, provider);
    }
    return provider;
  };
}
