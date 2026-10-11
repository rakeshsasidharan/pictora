import { describe, expect, it } from 'vitest';
import {
  ProviderError,
  ProviderRateLimitError,
  ProviderSafetyError,
  ProviderTimeoutError,
  toProviderError,
} from '../src/errors.js';
import { httpError } from './helpers.js';

describe('typed provider errors', () => {
  it('each carries a user-safe message', () => {
    for (const error of [
      new ProviderError('upstream said: internal key xyz'),
      new ProviderSafetyError('flagged: violence'),
      new ProviderRateLimitError('429 from api'),
      new ProviderTimeoutError('aborted'),
    ]) {
      expect(error).toBeInstanceOf(ProviderError);
      expect(error.userMessage).toMatch(/refunded/);
      expect(error.userMessage).not.toContain(error.message);
    }
  });

  it('marks only rate limits and transient errors as retryable', () => {
    expect(new ProviderRateLimitError('x').retryable).toBe(true);
    expect(new ProviderSafetyError('x').retryable).toBe(false);
    expect(new ProviderTimeoutError('x').retryable).toBe(false);
    expect(new ProviderError('x').retryable).toBe(false);
  });
});

describe('toProviderError', () => {
  it('passes typed errors through', () => {
    const error = new ProviderSafetyError('x');
    expect(toProviderError(error)).toBe(error);
  });

  it('maps HTTP 429 to a rate-limit error', () => {
    expect(toProviderError(httpError(429))).toBeInstanceOf(ProviderRateLimitError);
  });

  it.each([500, 502, 503, 504])('maps HTTP %i to a retryable provider error', (status) => {
    const error = toProviderError(httpError(status));
    expect(error.constructor).toBe(ProviderError);
    expect(error).toMatchObject({ status, retryable: true });
  });

  it('maps other 4xx to a non-retryable provider error', () => {
    expect(toProviderError(httpError(400))).toMatchObject({ status: 400, retryable: false });
  });

  it('reads the status from AWS SDK metadata', () => {
    const error = Object.assign(new Error('throttled'), { $metadata: { httpStatusCode: 429 } });
    expect(toProviderError(error)).toBeInstanceOf(ProviderRateLimitError);
  });

  it.each(['AbortError', 'TimeoutError'])('maps a %s to a timeout', (name) => {
    expect(toProviderError(new DOMException('stopped', name))).toBeInstanceOf(ProviderTimeoutError);
  });

  it('maps network errors to a retryable provider error', () => {
    const error = Object.assign(new Error('connect'), { code: 'ECONNREFUSED' });
    expect(toProviderError(error)).toMatchObject({ retryable: true });
  });

  it('maps anything else to a non-retryable provider error', () => {
    for (const thrown of [new Error('boom'), 'a string', undefined, { odd: true }]) {
      const error = toProviderError(thrown);
      expect(error.constructor).toBe(ProviderError);
      expect(error.retryable).toBe(false);
    }
  });
});
