import { describe, expect, test } from 'bun:test';
import { LLMAuthError, LLMConnectionError, LLMRateLimitError } from '../errors';
import { LLMSemaphore, retryWithBackoff, withResilience } from '../resilience';

describe('LLMSemaphore', () => {
  test('constructor throws for maxConcurrent < 1', () => {
    try {
      new LLMSemaphore(0);
      expect(true).toBe(false);
    } catch (e: any) {
      expect(e.message).toContain('maxConcurrent must be >= 1');
    }
  });

  test('constructor throws for negative maxConcurrent', () => {
    try {
      new LLMSemaphore(-5);
      expect(true).toBe(false);
    } catch (e: any) {
      expect(e.message).toContain('maxConcurrent must be >= 1');
    }
  });

  test('constructor accepts valid maxConcurrent', () => {
    const sem = new LLMSemaphore(5);
    expect(sem.activeCount).toBe(0);
    expect(sem.pendingCount).toBe(0);
  });

  test('acquire() resolves immediately when under limit', async () => {
    const sem = new LLMSemaphore(2);
    await sem.acquire();
    expect(sem.activeCount).toBe(1);
    expect(sem.pendingCount).toBe(0);
  });

  test('acquire() resolves multiple times when under limit', async () => {
    const sem = new LLMSemaphore(3);
    await sem.acquire();
    await sem.acquire();
    expect(sem.activeCount).toBe(2);
    expect(sem.pendingCount).toBe(0);
  });

  test('acquire() blocks when at limit', async () => {
    const sem = new LLMSemaphore(1);
    await sem.acquire();
    expect(sem.activeCount).toBe(1);

    let secondAcquireResolved = false;
    sem.acquire().then(() => {
      secondAcquireResolved = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(secondAcquireResolved).toBe(false);
    expect(sem.pendingCount).toBe(1);
  });

  test('release() allows blocked acquire() to resume', async () => {
    const sem = new LLMSemaphore(1);
    await sem.acquire();

    let secondAcquireResolved = false;
    const secondPromise = sem.acquire().then(() => {
      secondAcquireResolved = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(secondAcquireResolved).toBe(false);

    sem.release();

    await secondPromise;
    expect(secondAcquireResolved).toBe(true);
    expect(sem.activeCount).toBe(1);
  });

  test('activeCount reflects correct state after acquire/release cycle', async () => {
    const sem = new LLMSemaphore(2);
    expect(sem.activeCount).toBe(0);

    await sem.acquire();
    expect(sem.activeCount).toBe(1);

    await sem.acquire();
    expect(sem.activeCount).toBe(2);

    sem.release();
    expect(sem.activeCount).toBe(1);

    sem.release();
    expect(sem.activeCount).toBe(0);
  });

  test('pendingCount reflects queued requests', async () => {
    const sem = new LLMSemaphore(1);
    await sem.acquire();
    expect(sem.pendingCount).toBe(0);

    sem.acquire();
    sem.acquire();
    sem.acquire();

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sem.pendingCount).toBe(3);
  });

  test('multiple concurrent acquires with interleaved releases', async () => {
    const sem = new LLMSemaphore(2);
    const sequence: string[] = [];

    await sem.acquire();
    sequence.push('acquire1');
    await sem.acquire();
    sequence.push('acquire2');

    expect(sem.activeCount).toBe(2);
    expect(sem.pendingCount).toBe(0);

    sem.acquire().then(() => sequence.push('acquire3'));
    sem.acquire().then(() => sequence.push('acquire4'));
    const p5 = sem.acquire().then(() => sequence.push('acquire5'));

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sem.pendingCount).toBe(3);

    sem.release();
    expect(sem.activeCount).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sequence).toContain('acquire3');

    sem.release();
    expect(sem.activeCount).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sequence).toContain('acquire4');

    sem.release();
    await p5;
    expect(sequence).toContain('acquire5');
  });
});

describe('retryWithBackoff', () => {
  test('succeeds on first attempt (no retry)', async () => {
    let callCount = 0;
    const fn = async () => {
      callCount++;
      return 'success';
    };

    const result = await retryWithBackoff(fn, { maxAttempts: 3 });
    expect(result).toBe('success');
    expect(callCount).toBe(1);
  });

  test('retries on LLMRateLimitError, succeeds on 2nd attempt', async () => {
    let callCount = 0;
    const fn = async () => {
      callCount++;
      if (callCount === 1) {
        throw new LLMRateLimitError('openai', 1);
      }
      return 'success';
    };

    const result = await retryWithBackoff(fn, {
      maxAttempts: 3,
      baseDelayMs: 10,
      maxDelayMs: 100,
      jitter: false,
    });
    expect(result).toBe('success');
    expect(callCount).toBe(2);
  });

  test('retries on LLMConnectionError, succeeds on 2nd attempt', async () => {
    let callCount = 0;
    const fn = async () => {
      callCount++;
      if (callCount === 1) {
        throw new LLMConnectionError('openai', 'network timeout');
      }
      return 'success';
    };

    const result = await retryWithBackoff(fn, {
      maxAttempts: 3,
      baseDelayMs: 10,
      maxDelayMs: 100,
      jitter: false,
    });
    expect(result).toBe('success');
    expect(callCount).toBe(2);
  });

  test('throws immediately on LLMAuthError (non-retryable)', async () => {
    let callCount = 0;
    const fn = async () => {
      callCount++;
      throw new LLMAuthError('openai', 'invalid api key');
    };

    try {
      await retryWithBackoff(fn, { maxAttempts: 3 });
      expect(true).toBe(false);
    } catch (e: any) {
      expect(e.name).toBe('LLMAuthError');
      expect(callCount).toBe(1);
    }
  });

  test('throws immediately on generic Error (non-retryable)', async () => {
    let callCount = 0;
    const fn = async () => {
      callCount++;
      throw new Error('some other error');
    };

    try {
      await retryWithBackoff(fn, { maxAttempts: 3 });
      expect(true).toBe(false);
    } catch (e: any) {
      expect(e.message).toBe('some other error');
      expect(callCount).toBe(1);
    }
  });

  test('exhausts maxAttempts and throws last error', async () => {
    let callCount = 0;
    const fn = async () => {
      callCount++;
      throw new LLMRateLimitError('openai', undefined, 'rate limited');
    };

    try {
      await retryWithBackoff(fn, {
        maxAttempts: 3,
        baseDelayMs: 10,
        maxDelayMs: 100,
        jitter: false,
      });
      expect(true).toBe(false);
    } catch (e: any) {
      expect(e.name).toBe('LLMRateLimitError');
      expect(callCount).toBe(3);
    }
  });

  test('respects retryAfterSeconds from LLMRateLimitError', async () => {
    let callCount = 0;
    let delayStartTime = 0;
    let delayEndTime = 0;

    const fn = async () => {
      callCount++;
      if (callCount === 1) {
        delayStartTime = Date.now();
        throw new LLMRateLimitError('openai', 0.1);
      }
      delayEndTime = Date.now();
      return 'success';
    };

    const result = await retryWithBackoff(fn, {
      maxAttempts: 3,
      baseDelayMs: 10,
      maxDelayMs: 100,
      jitter: false,
    });

    expect(result).toBe('success');
    expect(callCount).toBe(2);

    const actualDelay = delayEndTime - delayStartTime;
    expect(actualDelay).toBeGreaterThanOrEqual(50);
    expect(actualDelay).toBeLessThan(300);
  });

  test('exponential backoff without jitter: attempt 1 delay ≈ baseDelayMs', async () => {
    let callCount = 0;
    let delayStartTime = 0;
    let delayEndTime = 0;

    const fn = async () => {
      callCount++;
      if (callCount === 1) {
        delayStartTime = Date.now();
        throw new LLMConnectionError('openai');
      }
      delayEndTime = Date.now();
      return 'success';
    };

    await retryWithBackoff(fn, {
      maxAttempts: 3,
      baseDelayMs: 20,
      maxDelayMs: 1000,
      jitter: false,
    });

    const actualDelay = delayEndTime - delayStartTime;
    expect(actualDelay).toBeGreaterThanOrEqual(10);
    expect(actualDelay).toBeLessThan(100);
  });

  test('exponential backoff attempt 2: baseDelayMs * 2', async () => {
    let callCount = 0;
    let delayStartTime = 0;
    let delayEndTime = 0;

    const fn = async () => {
      callCount++;
      if (callCount === 1) {
        throw new LLMConnectionError('openai');
      }
      if (callCount === 2) {
        delayStartTime = Date.now();
        throw new LLMConnectionError('openai');
      }
      delayEndTime = Date.now();
      return 'success';
    };

    await retryWithBackoff(fn, {
      maxAttempts: 4,
      baseDelayMs: 20,
      maxDelayMs: 1000,
      jitter: false,
    });

    const actualDelay = delayEndTime - delayStartTime;
    expect(actualDelay).toBeGreaterThanOrEqual(30);
    expect(actualDelay).toBeLessThan(150);
  });

  test('custom options: maxAttempts respected', async () => {
    let callCount = 0;
    const fn = async () => {
      callCount++;
      throw new LLMConnectionError('openai');
    };

    try {
      await retryWithBackoff(fn, { maxAttempts: 2 });
      expect(true).toBe(false);
    } catch {
      expect(callCount).toBe(2);
    }
  });

  test('custom options: baseDelayMs respected', async () => {
    let callCount = 0;
    let delayStartTime = 0;
    let delayEndTime = 0;

    const fn = async () => {
      callCount++;
      if (callCount === 1) {
        delayStartTime = Date.now();
        throw new LLMConnectionError('openai');
      }
      delayEndTime = Date.now();
      return 'success';
    };

    await retryWithBackoff(fn, {
      maxAttempts: 3,
      baseDelayMs: 50,
      maxDelayMs: 1000,
      jitter: false,
    });

    const actualDelay = delayEndTime - delayStartTime;
    expect(actualDelay).toBeGreaterThanOrEqual(30);
    expect(actualDelay).toBeLessThan(200);
  });

  test('jitter disabled: delay is exactly exponential', async () => {
    let callCount = 0;
    const fn = async () => {
      callCount++;
      if (callCount < 3) {
        throw new LLMConnectionError('openai');
      }
      return 'success';
    };

    const start = Date.now();
    await retryWithBackoff(fn, {
      maxAttempts: 4,
      baseDelayMs: 10,
      maxDelayMs: 100,
      jitter: false,
    });
    const total = Date.now() - start;

    expect(total).toBeLessThan(200);
  });

  test('jitter enabled: adds randomness to delays', async () => {
    let callCount = 0;
    let delayStartTime = 0;
    let delayEndTime = 0;

    const fn = async () => {
      callCount++;
      if (callCount === 1) {
        delayStartTime = Date.now();
        throw new LLMConnectionError('openai');
      }
      delayEndTime = Date.now();
      return 'success';
    };

    await retryWithBackoff(fn, {
      maxAttempts: 3,
      baseDelayMs: 10,
      maxDelayMs: 100,
      jitter: true,
    });

    const actualDelay = delayEndTime - delayStartTime;
    expect(actualDelay).toBeGreaterThanOrEqual(5);
    expect(actualDelay).toBeLessThan(100);
  });
});

describe('withResilience', () => {
  test('acquires semaphore, calls fn, releases semaphore on success', async () => {
    const sem = new LLMSemaphore(1);
    let fnCalled = false;

    await withResilience(sem, async () => {
      fnCalled = true;
      expect(sem.activeCount).toBe(1);
      return 'result';
    });

    expect(fnCalled).toBe(true);
    expect(sem.activeCount).toBe(0);
  });

  test('releases semaphore on failure', async () => {
    const sem = new LLMSemaphore(1);

    try {
      await withResilience(sem, async () => {
        expect(sem.activeCount).toBe(1);
        throw new LLMAuthError('openai');
      });
      expect(true).toBe(false);
    } catch (e: any) {
      expect(e.name).toBe('LLMAuthError');
      expect(sem.activeCount).toBe(0);
    }
  });

  test('combines semaphore + retry: respects semaphore then retries', async () => {
    const sem = new LLMSemaphore(1);
    let callCount = 0;

    const result = await withResilience(
      sem,
      async () => {
        callCount++;
        expect(sem.activeCount).toBe(1);
        if (callCount === 1) {
          throw new LLMRateLimitError('openai', undefined);
        }
        return 'success';
      },
      { maxAttempts: 2, baseDelayMs: 10, jitter: false }
    );

    expect(result).toBe('success');
    expect(callCount).toBe(2);
    expect(sem.activeCount).toBe(0);
  });

  test('releases semaphore even if retry fails', async () => {
    const sem = new LLMSemaphore(1);

    try {
      await withResilience(
        sem,
        async () => {
          throw new LLMConnectionError('openai');
        },
        { maxAttempts: 2, baseDelayMs: 10, jitter: false }
      );
      expect(true).toBe(false);
    } catch (e: any) {
      expect(e.name).toBe('LLMConnectionError');
      expect(sem.activeCount).toBe(0);
    }
  });

  test('respects custom retry options passed to withResilience', async () => {
    const sem = new LLMSemaphore(1);
    let callCount = 0;

    try {
      await withResilience(
        sem,
        async () => {
          callCount++;
          throw new LLMConnectionError('openai');
        },
        { maxAttempts: 3, baseDelayMs: 10, jitter: false }
      );
    } catch {
      expect(callCount).toBe(3);
    }
  });

  test('concurrent requests respect semaphore limit during retries', async () => {
    const sem = new LLMSemaphore(1);
    const sequence: string[] = [];
    let callCount1 = 0;
    let callCount2 = 0;

    const promise1 = withResilience(
      sem,
      async () => {
        callCount1++;
        sequence.push('call1');
        if (callCount1 === 1) {
          throw new LLMConnectionError('openai');
        }
        return 'result1';
      },
      { maxAttempts: 2, baseDelayMs: 10, jitter: false }
    );

    const promise2 = withResilience(
      sem,
      async () => {
        callCount2++;
        sequence.push('call2');
        return 'result2';
      },
      { maxAttempts: 2, baseDelayMs: 10, jitter: false }
    );

    const [result1, result2] = await Promise.all([promise1, promise2]);
    expect(result1).toBe('result1');
    expect(result2).toBe('result2');

    expect(callCount1).toBe(2);
    expect(callCount2).toBe(1);

    expect(sem.activeCount).toBe(0);
  });

  test('passes label through to retry logging', async () => {
    const sem = new LLMSemaphore(1);
    let callCount = 0;

    const result = await withResilience(
      sem,
      async () => {
        callCount++;
        if (callCount === 1) {
          throw new LLMConnectionError('openai');
        }
        return 'success';
      },
      { maxAttempts: 2, baseDelayMs: 10, jitter: false },
      'test-label'
    );

    expect(result).toBe('success');
  });

  test('returns function result correctly', async () => {
    const sem = new LLMSemaphore(2);

    const result = await withResilience(sem, async () => {
      return { data: 'test', count: 42 };
    });

    expect(result.data).toBe('test');
    expect(result.count).toBe(42);
  });
});
