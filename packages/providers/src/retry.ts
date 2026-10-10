import { ProviderTimeoutError, toProviderError } from './errors.js';

/** Each provider call gets 120 s (tech design 5.1). */
export const PROVIDER_TIMEOUT_MS = 120_000;

/** One retry, 2 s after the first failure, plus up to 1 s of jitter (tech design 5.2). */
export const RETRY_DELAY_MS = 2_000;
export const RETRY_JITTER_MS = 1_000;

export interface RetryOptions {
  signal: AbortSignal;
  delayMs?: number;
  jitterMs?: number;
  /** Returns a number in [0, 1); for tests. */
  random?: () => number;
}

/** A signal that aborts after the provider timeout, or when `parent` aborts. */
export function providerSignal(parent?: AbortSignal, timeoutMs = PROVIDER_TIMEOUT_MS): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

/**
 * Runs `call`, retrying once on a rate limit, a 5xx response or a network error. Never retries a 4xx,
 * a safety refusal or a timeout. Every error is rethrown as a typed provider error, and an abort, before
 * or during the wait, stops at once with `ProviderTimeoutError`.
 */
export async function withRetry<T>(call: () => Promise<T>, options: RetryOptions): Promise<T> {
  const {
    signal,
    delayMs = RETRY_DELAY_MS,
    jitterMs = RETRY_JITTER_MS,
    random = Math.random,
  } = options;
  throwIfAborted(signal);
  try {
    return await call();
  } catch (error) {
    const providerError = toProviderError(error);
    if (signal.aborted) throw abortError(signal);
    if (!providerError.retryable) throw providerError;
    await sleep(delayMs + Math.floor(random() * jitterMs), signal);
  }
  try {
    return await call();
  } catch (error) {
    if (signal.aborted) throw abortError(signal);
    throw toProviderError(error);
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}

function abortError(signal: AbortSignal): ProviderTimeoutError {
  return new ProviderTimeoutError('Provider call aborted or timed out', { cause: signal.reason });
}

/** Waits `ms`, rejecting with `ProviderTimeoutError` as soon as the signal aborts. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
