import { describe, expect, it, vi } from 'vitest';
import {
  ProviderError,
  ProviderRateLimitError,
  ProviderSafetyError,
  ProviderTimeoutError,
} from '../src/errors.js';
import { PROVIDER_TIMEOUT_MS, providerSignal, RETRY_DELAY_MS, withRetry } from '../src/retry.js';
import { httpError } from './helpers.js';

/** No real waiting: a 1 ms delay and no jitter. */
const fast = { delayMs: 1, jitterMs: 0 };

function signal(): AbortSignal {
  return new AbortController().signal;
}

describe('withRetry', () => {
  it('returns the first result without retrying', async () => {
    const call = vi.fn().mockResolvedValue('ok');
    await expect(withRetry(call, { ...fast, signal: signal() })).resolves.toBe('ok');
    expect(call).toHaveBeenCalledTimes(1);
  });

  it.each([
    [429, ProviderRateLimitError],
    [503, ProviderError],
  ])('retries once on HTTP %i', async (status) => {
    const call = vi.fn().mockRejectedValueOnce(httpError(status)).mockResolvedValue('ok');
    await expect(withRetry(call, { ...fast, signal: signal() })).resolves.toBe('ok');
    expect(call).toHaveBeenCalledTimes(2);
  });

  it.each([
    [429, ProviderRateLimitError],
    [503, ProviderError],
  ])('gives up after one retry on HTTP %i', async (status, errorClass) => {
    const call = vi.fn().mockRejectedValue(httpError(status));
    const result = withRetry(call, { ...fast, signal: signal() });
    await expect(result).rejects.toBeInstanceOf(errorClass);
    await expect(result).rejects.toMatchObject({ status });
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('retries once on a network error', async () => {
    const network = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
    });
    const call = vi.fn().mockRejectedValueOnce(network).mockResolvedValue('ok');
    await expect(withRetry(call, { ...fast, signal: signal() })).resolves.toBe('ok');
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('does not retry on HTTP 400', async () => {
    const call = vi.fn().mockRejectedValue(httpError(400));
    const result = withRetry(call, { ...fast, signal: signal() });
    await expect(result).rejects.toBeInstanceOf(ProviderError);
    await expect(result).rejects.toMatchObject({ status: 400, retryable: false });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('does not retry on a safety refusal', async () => {
    const call = vi.fn().mockRejectedValue(new ProviderSafetyError('refused'));
    await expect(withRetry(call, { ...fast, signal: signal() })).rejects.toBeInstanceOf(
      ProviderSafetyError,
    );
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('waits 2 s plus jitter before the retry', async () => {
    vi.useFakeTimers();
    try {
      const call = vi.fn().mockRejectedValueOnce(httpError(429)).mockResolvedValue('ok');
      const result = withRetry(call, { signal: signal(), random: () => 0.5 });
      await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS + 499);
      expect(call).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toBe('ok');
      expect(call).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops when aborted during the wait, without retrying', async () => {
    const controller = new AbortController();
    const call = vi.fn().mockRejectedValue(httpError(503));
    const result = withRetry(call, { delayMs: 10_000, jitterMs: 0, signal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    await expect(result).rejects.toBeInstanceOf(ProviderTimeoutError);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('does not call the provider when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const call = vi.fn().mockResolvedValue('ok');
    await expect(withRetry(call, { ...fast, signal: controller.signal })).rejects.toBeInstanceOf(
      ProviderTimeoutError,
    );
    expect(call).not.toHaveBeenCalled();
  });

  it('reports a call that failed because of the abort as a timeout', async () => {
    const controller = new AbortController();
    const call = vi.fn().mockImplementation(async () => {
      controller.abort();
      throw httpError(503);
    });
    await expect(withRetry(call, { ...fast, signal: controller.signal })).rejects.toBeInstanceOf(
      ProviderTimeoutError,
    );
    expect(call).toHaveBeenCalledTimes(1);
  });
});

describe('providerSignal', () => {
  it('defaults to the 120 s provider timeout', () => {
    expect(PROVIDER_TIMEOUT_MS).toBe(120_000);
  });

  it('aborts with a TimeoutError once the timeout passes', async () => {
    const timed = providerSignal(undefined, 10);
    expect(timed.aborted).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(timed.aborted).toBe(true);
    expect((timed.reason as DOMException).name).toBe('TimeoutError');
  });

  it('aborts when the parent aborts', () => {
    const parent = new AbortController();
    const combined = providerSignal(parent.signal);
    parent.abort();
    expect(combined.aborted).toBe(true);
  });
});
