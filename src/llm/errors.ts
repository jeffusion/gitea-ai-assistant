/**
 * Standardized error types for the LLM layer.
 *
 * All provider adapters catch native errors and re-throw as one of these.
 * Business code only needs to handle LLMError subtypes.
 */

// ---------------------------------------------------------------------------
// Base error
// ---------------------------------------------------------------------------

export class LLMError extends Error {
  /** Provider type that caused the error */
  readonly provider: string;
  /** HTTP status code from the provider, if available */
  readonly statusCode?: number;

  constructor(message: string, provider: string, statusCode?: number) {
    super(message);
    this.name = 'LLMError';
    this.provider = provider;
    this.statusCode = statusCode;
  }
}

// ---------------------------------------------------------------------------
// Specific error types
// ---------------------------------------------------------------------------

/** Authentication failed (invalid/expired API key). */
export class LLMAuthError extends LLMError {
  constructor(provider: string, message?: string) {
    super(message || 'Authentication failed: invalid or expired API key', provider, 401);
    this.name = 'LLMAuthError';
  }
}

/** Rate limit exceeded. */
export class LLMRateLimitError extends LLMError {
  /** Seconds until the rate limit resets, if provided by the provider. */
  readonly retryAfterSeconds?: number;

  constructor(provider: string, retryAfterSeconds?: number, message?: string) {
    super(
      message ||
        `Rate limit exceeded${retryAfterSeconds ? ` (retry after ${retryAfterSeconds}s)` : ''}`,
      provider,
      429
    );
    this.name = 'LLMRateLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Input too long / context window exceeded. */
export class LLMContextLengthError extends LLMError {
  constructor(provider: string, message?: string) {
    super(message || 'Input exceeds model context length', provider, 400);
    this.name = 'LLMContextLengthError';
  }
}

/** Provider returned an invalid or unparseable response. */
export class LLMResponseError extends LLMError {
  /** The raw response body that couldn't be parsed */
  readonly rawResponse?: unknown;

  constructor(provider: string, message?: string, rawResponse?: unknown) {
    super(message || 'Invalid response from provider', provider);
    this.name = 'LLMResponseError';
    this.rawResponse = rawResponse;
  }
}

/** Provider is unreachable (network error, timeout, 5xx). */
export class LLMConnectionError extends LLMError {
  constructor(provider: string, message?: string, statusCode?: number) {
    super(message || 'Failed to connect to provider', provider, statusCode);
    this.name = 'LLMConnectionError';
  }
}
