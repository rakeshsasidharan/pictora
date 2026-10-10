/**
 * Typed provider errors (tech design 6.2). The worker maps them to job states: a safety error blocks the
 * job, anything else fails it. `userMessage` is safe to show; `message` may hold provider detail for logs.
 */
export class ProviderError extends Error {
  readonly userMessage: string;
  /** True when one retry may succeed: 5xx responses and network errors. */
  readonly retryable: boolean;
  /** The provider's HTTP status, when there was one. */
  readonly status?: number;

  constructor(
    message: string,
    options: { userMessage?: string; retryable?: boolean; status?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'ProviderError';
    this.userMessage =
      options.userMessage ?? 'The image service had a problem. Your points have been refunded.';
    this.retryable = options.retryable ?? false;
    this.status = options.status;
  }
}

/** The provider refused the prompt or image on safety grounds. Never retried. */
export class ProviderSafetyError extends ProviderError {
  constructor(message: string, options: { status?: number; cause?: unknown } = {}) {
    super(message, {
      ...options,
      retryable: false,
      userMessage:
        'This request was blocked by the image service’s safety filter. Your points have been refunded.',
    });
    this.name = 'ProviderSafetyError';
  }
}

/** The provider is rate limiting us (HTTP 429). Retried once. */
export class ProviderRateLimitError extends ProviderError {
  constructor(message: string, options: { status?: number; cause?: unknown } = {}) {
    super(message, {
      ...options,
      retryable: true,
      userMessage:
        'The image service is busy right now. Your points have been refunded; try again soon.',
    });
    this.name = 'ProviderRateLimitError';
  }
}

/** The call ran past its deadline or was aborted. Not retried: the deadline has passed. */
export class ProviderTimeoutError extends ProviderError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, {
      ...options,
      retryable: false,
      userMessage: 'The image service took too long to answer. Your points have been refunded.',
    });
    this.name = 'ProviderTimeoutError';
  }
}

/** Error codes Node uses for network failures worth one retry. */
const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/**
 * Maps anything an adapter or SDK throws to one of the four typed errors:
 * an abort or timeout → `ProviderTimeoutError`; HTTP 429 → `ProviderRateLimitError`;
 * 5xx or a network error → retryable `ProviderError`; anything else → non-retryable `ProviderError`.
 * Adapters map safety refusals themselves, since each provider reports them differently.
 */
export function toProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;

  const name = errorName(error);
  if (name === 'AbortError' || name === 'TimeoutError') {
    return new ProviderTimeoutError('Provider call aborted or timed out', { cause: error });
  }

  const message = error instanceof Error ? error.message : String(error);
  const status = httpStatus(error);
  if (status === 429) return new ProviderRateLimitError(message, { status, cause: error });
  if (status === 408 || status === 504) {
    return new ProviderError(message, { status, retryable: true, cause: error });
  }
  if (status !== undefined && status >= 500) {
    return new ProviderError(message, { status, retryable: true, cause: error });
  }
  if (status !== undefined) return new ProviderError(message, { status, cause: error });

  return new ProviderError(message, { retryable: isNetworkError(error), cause: error });
}

function errorName(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'name' in error
    ? String((error as { name: unknown }).name)
    : undefined;
}

/** The HTTP status from SDK errors, which use `status`, `statusCode` or `$metadata.httpStatusCode`. */
function httpStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const record = error as Record<string, unknown>;
  const metadata = record.$metadata as Record<string, unknown> | undefined;
  for (const value of [record.status, record.statusCode, metadata?.httpStatusCode]) {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 400 && value < 600) {
      return value;
    }
  }
  return undefined;
}

function isNetworkError(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 5; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && NETWORK_ERROR_CODES.has(code)) return true;
    // fetch reports network failures as `TypeError: fetch failed`, with the socket error as the cause.
    if (current instanceof TypeError && current.message === 'fetch failed') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
