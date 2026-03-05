/**
 * LLM Resilience Layer — Semaphore + Retry-with-Backoff.
 *
 * Provides concurrency control and automatic retry for LLM API calls.
 * Designed to be integrated into the LLMGateway as a transparent wrapper.
 */

import { logger } from '../utils/logger';
import { LLMConnectionError, LLMRateLimitError } from './errors';

// ---------------------------------------------------------------------------
// Semaphore — limits concurrent in-flight LLM requests
// ---------------------------------------------------------------------------

export class LLMSemaphore {
  private current = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly maxConcurrent: number) {
    if (maxConcurrent < 1) {
      throw new Error(`maxConcurrent must be >= 1, got ${maxConcurrent}`);
    }
  }

  async acquire(): Promise<void> {
    if (this.current < this.maxConcurrent) {
      this.current++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.current++;
        resolve();
      });
    });
  }

  release(): void {
    this.current--;
    const next = this.queue.shift();
    if (next) {
      next();
    }
  }

  /** Current number of in-flight requests. */
  get activeCount(): number {
    return this.current;
  }

  /** Number of requests waiting for a slot. */
  get pendingCount(): number {
    return this.queue.length;
  }
}

// ---------------------------------------------------------------------------
// Retry with Exponential Backoff
// ---------------------------------------------------------------------------

export interface RetryOptions {
  /** Maximum number of attempts (including the first). Default: 3 */
  maxAttempts: number;
  /** Base delay in milliseconds. Default: 1000 */
  baseDelayMs: number;
  /** Maximum delay cap in milliseconds. Default: 60000 */
  maxDelayMs: number;
  /** Whether to add jitter to delays. Default: true */
  jitter: boolean;
}

const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 60000,
  jitter: true,
};

/**
 * Determines whether an error is retryable.
 * Only rate limit (429) and connection errors (5xx, network) are retried.
 */
function isRetryableError(error: unknown): boolean {
  return error instanceof LLMRateLimitError || error instanceof LLMConnectionError;
}

/**
 * Calculates the delay for a given attempt.
 * Respects `retryAfterSeconds` from rate limit responses when available.
 */
function calculateDelay(attempt: number, error: unknown, options: RetryOptions): number {
  // If the provider told us when to retry, respect that
  if (error instanceof LLMRateLimitError && error.retryAfterSeconds) {
    return error.retryAfterSeconds * 1000;
  }

  // Exponential backoff: baseDelay * 2^(attempt-1), capped at maxDelay
  const exponential = Math.min(options.baseDelayMs * 2 ** (attempt - 1), options.maxDelayMs);

  // Add jitter to prevent thundering herd
  const jitter = options.jitter ? Math.random() * options.baseDelayMs : 0;

  return exponential + jitter;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retries an async function with exponential backoff.
 * Only retries on LLMRateLimitError and LLMConnectionError.
 * All other errors are thrown immediately.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options?: Partial<RetryOptions>,
  label?: string
): Promise<T> {
  const opts = { ...DEFAULT_RETRY_OPTIONS, ...options };

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const isLast = attempt === opts.maxAttempts;
      const isRetryable = isRetryableError(error);

      if (isLast || !isRetryable) {
        throw error;
      }

      const delayMs = calculateDelay(attempt, error, opts);
      const errorName = error instanceof Error ? error.constructor.name : 'UnknownError';

      logger.warn(
        `LLM call${label ? ` [${label}]` : ''} failed (${errorName}), retrying in ${Math.round(delayMs)}ms`,
        {
          attempt,
          maxAttempts: opts.maxAttempts,
          delayMs: Math.round(delayMs),
          error: error instanceof Error ? error.message : String(error),
        }
      );

      await sleep(delayMs);
    }
  }

  // TypeScript exhaustiveness — should never reach here
  throw new Error('retryWithBackoff: unreachable');
}

// ---------------------------------------------------------------------------
// Combined: withResilience wraps a call with semaphore + retry
// ---------------------------------------------------------------------------

/**
 * Wraps an async function with semaphore-based concurrency control and retry logic.
 */
export async function withResilience<T>(
  semaphore: LLMSemaphore,
  fn: () => Promise<T>,
  retryOptions?: Partial<RetryOptions>,
  label?: string
): Promise<T> {
  await semaphore.acquire();
  try {
    return await retryWithBackoff(fn, retryOptions, label);
  } finally {
    semaphore.release();
  }
}
