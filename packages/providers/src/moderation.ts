import type { ModerationResult } from '@pictora/core';
import { ProviderError, toProviderError } from './errors.js';
import { providerSignal, withRetry, type RetryOptions } from './retry.js';

/** The OpenAI moderation model and endpoint (tech design 6.3). The endpoint is free to call. */
export const MODERATION_MODEL = 'omni-moderation-latest';
export const OPENAI_MODERATION_URL = 'https://api.openai.com/v1/moderations';

/** A moderation call gets 15 s, retry included. */
export const MODERATION_TIMEOUT_MS = 15_000;

/** What to check: a prompt, an image, or both in one call. */
export interface ModerationInput {
  text?: string;
  /** Image bytes (PNG, JPEG or WebP), sent as a data URL. */
  image?: Uint8Array;
}

/** Checks text and images; throws a typed provider error when the check itself fails. */
export type Moderate = (
  input: ModerationInput,
  options?: { signal?: AbortSignal },
) => Promise<ModerationResult>;

export interface ModeratorOptions {
  /** The OpenAI API key, read from Secrets Manager in a deployed worker. */
  apiKey: () => Promise<string>;
  url?: string;
  timeoutMs?: number;
  /** Retry settings apart from the signal; for tests. */
  retry?: Omit<RetryOptions, 'signal'>;
}

interface ModerationResponse {
  results?: { flagged?: unknown; categories?: Record<string, unknown> }[];
}

/**
 * A moderation client for `omni-moderation-latest`. It retries once on a rate limit, a 5xx or a network
 * error, and throws instead of answering when the endpoint can't be reached, so callers fail safe. With text
 * and an image, both go in one call and the answer covers both.
 */
export function createModerator(options: ModeratorOptions): Moderate {
  const url = options.url ?? OPENAI_MODERATION_URL;
  const timeoutMs = options.timeoutMs ?? MODERATION_TIMEOUT_MS;

  return async (input, { signal } = {}) => {
    const text = input.text?.trim();
    const parts = [
      ...(text ? [{ type: 'text', text }] : []),
      ...(input.image
        ? [{ type: 'image_url', image_url: { url: imageDataUrl(input.image) } }]
        : []),
    ];
    if (parts.length === 0) throw new ProviderError('Nothing to moderate');

    let apiKey: string;
    try {
      apiKey = await options.apiKey();
    } catch (error) {
      throw new ProviderError('The moderation API key could not be read', { cause: error });
    }
    const callSignal = providerSignal(signal, timeoutMs);
    const body = await withRetry(
      async () => {
        const response = await fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: MODERATION_MODEL, input: parts }),
          signal: callSignal,
        });
        if (!response.ok) {
          throw toProviderError(
            Object.assign(new Error(`Moderation request failed with HTTP ${response.status}`), {
              status: response.status,
            }),
          );
        }
        return (await response.json()) as ModerationResponse;
      },
      { ...options.retry, signal: callSignal },
    );
    return parseModeration(body);
  };
}

/** Combines the per-input results into one: flagged if any is, with every flagged category. */
export function parseModeration(body: ModerationResponse): ModerationResult {
  const results = body.results;
  if (!Array.isArray(results) || results.length === 0) {
    throw new ProviderError('Moderation response had no results');
  }
  const categories: Record<string, boolean> = {};
  let flagged = false;
  for (const result of results) {
    if (typeof result.flagged !== 'boolean') {
      throw new ProviderError('Moderation response had no flagged value');
    }
    flagged ||= result.flagged;
    for (const [category, value] of Object.entries(result.categories ?? {})) {
      categories[category] = categories[category] === true || value === true;
    }
  }
  return { flagged, categories };
}

/** A data URL for image bytes, with the type read from the file's signature. */
export function imageDataUrl(bytes: Uint8Array): string {
  return `data:${imageType(bytes)};base64,${Buffer.from(bytes).toString('base64')}`;
}

function imageType(bytes: Uint8Array): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  const riff = Buffer.from(bytes.subarray(0, 4)).toString('latin1');
  const webp = Buffer.from(bytes.subarray(8, 12)).toString('latin1');
  if (riff === 'RIFF' && webp === 'WEBP') return 'image/webp';
  throw new ProviderError('Only PNG, JPEG and WebP images can be moderated');
}
