import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { cleanupScheduler } from '../cleanup-scheduler';
import { LocalRepoManager } from '../context/local-repo-manager';

type PendingTimer = {
  callback: TimerHandler;
  delay: number;
};

function toDelayNumber(delay: number | undefined): number {
  return typeof delay === 'number' ? delay : 0;
}

function calcDelayToNext2Am(nowTimestamp: number): number {
  const now = new Date(nowTimestamp);
  const next = new Date(now);
  next.setHours(2, 0, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime() - now.getTime();
}

describe('cleanupScheduler', () => {
  let pendingTimers: Map<number, PendingTimer>;
  let nextTimerId: number;

  beforeEach(() => {
    pendingTimers = new Map<number, PendingTimer>();
    nextTimerId = 1;

    const setTimeoutBase = (callback: TimerHandler, delay?: number, ..._args: unknown[]) => {
      const timerId = nextTimerId;
      nextTimerId += 1;
      pendingTimers.set(timerId, { callback, delay: toDelayNumber(delay) });
      return timerId as unknown as ReturnType<typeof setTimeout>;
    };
    const setTimeoutImpl = Object.assign(setTimeoutBase, {
      __promisify__: globalThis.setTimeout.__promisify__,
    }) as unknown as typeof setTimeout;

    const clearTimeoutImpl = ((timerId?: number | Timer) => {
      const numericTimerId = Number(timerId);
      pendingTimers.delete(numericTimerId);
    }) as typeof clearTimeout;

    spyOn(globalThis, 'setTimeout').mockImplementation(setTimeoutImpl);
    spyOn(globalThis, 'clearTimeout').mockImplementation(clearTimeoutImpl);
  });

  afterEach(() => {
    cleanupScheduler.stop();
    mock.restore();
  });

  test('start() is idempotent and does not create multiple timers', () => {
    cleanupScheduler.start();
    cleanupScheduler.start();

    expect(globalThis.setTimeout).toHaveBeenCalledTimes(1);
    expect(pendingTimers.size).toBe(1);
  });

  test('stop() clears active timer', () => {
    cleanupScheduler.start();
    const clearTimeoutSpy = globalThis.clearTimeout;

    cleanupScheduler.stop();

    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(pendingTimers.size).toBe(0);
  });

  test('stop() after start() then start() again re-schedules correctly', () => {
    cleanupScheduler.start();
    cleanupScheduler.stop();
    cleanupScheduler.start();

    expect(globalThis.setTimeout).toHaveBeenCalledTimes(2);
    expect(globalThis.clearTimeout).toHaveBeenCalledTimes(1);
    expect(pendingTimers.size).toBe(1);
  });

  test('schedule logic computes delay to next 2:00 AM', async () => {
    const cleanSpy = spyOn(LocalRepoManager.prototype, 'cleanStaleMirrors').mockResolvedValue(0);

    cleanupScheduler.start();

    const firstTimer = pendingTimers.get(1);
    expect(firstTimer).toBeDefined();
    expect(firstTimer?.delay).toBe(60_000);

    const beforeTrigger = Date.now();
    if (typeof firstTimer?.callback === 'function') {
      firstTimer.callback();
    }
    const afterTrigger = Date.now();

    const scheduledTimer = pendingTimers.get(2);
    expect(scheduledTimer).toBeDefined();

    const expectedMin = calcDelayToNext2Am(afterTrigger);
    const expectedMax = calcDelayToNext2Am(beforeTrigger);

    expect(scheduledTimer?.delay).toBeGreaterThanOrEqual(expectedMin);
    expect(scheduledTimer?.delay).toBeLessThanOrEqual(expectedMax);
    expect(cleanSpy).toHaveBeenCalledTimes(1);
  });

  test('stop() prevents pending cleanup execution', () => {
    const cleanSpy = spyOn(LocalRepoManager.prototype, 'cleanStaleMirrors').mockResolvedValue(0);

    cleanupScheduler.start();
    cleanupScheduler.stop();

    expect(pendingTimers.size).toBe(0);
    expect(cleanSpy).not.toHaveBeenCalled();
  });
});
