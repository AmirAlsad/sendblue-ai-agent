import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemorySmsLimitStallScheduler, transientRetryDelayMs } from '../../src/limits/retry.js';

describe('transientRetryDelayMs', () => {
  it('returns 0 for non-positive attempts', () => {
    expect(transientRetryDelayMs(0, 1000, 60000, () => 0.5)).toBe(0);
    expect(transientRetryDelayMs(-1, 1000, 60000, () => 0.5)).toBe(0);
  });

  it('produces approximately 1s/4s/16s on attempts 1-3 with default jitter', () => {
    // Center jitter (random=0.5) → multiplier = 1.0
    expect(transientRetryDelayMs(1, 1000, 60000, () => 0.5)).toBe(1000);
    expect(transientRetryDelayMs(2, 1000, 60000, () => 0.5)).toBe(4000);
    expect(transientRetryDelayMs(3, 1000, 60000, () => 0.5)).toBe(16000);
  });

  it('caps at maxMs', () => {
    // attempt 4 raw = 64s, cap = 60s, jitter 0.5 → 60000
    expect(transientRetryDelayMs(4, 1000, 60000, () => 0.5)).toBe(60000);
    // attempt 10 raw is huge, should still cap
    expect(transientRetryDelayMs(10, 1000, 60000, () => 0.5)).toBe(60000);
  });

  it('jitters within ±20% of the raw value', () => {
    // random=0 → 0.8x, random≈1 → 1.2x
    const low = transientRetryDelayMs(1, 1000, 60000, () => 0);
    const high = transientRetryDelayMs(1, 1000, 60000, () => 0.999);
    expect(low).toBeGreaterThanOrEqual(800);
    expect(low).toBeLessThanOrEqual(801);
    expect(high).toBeGreaterThanOrEqual(1199);
    expect(high).toBeLessThanOrEqual(1200);
  });
});

describe('InMemorySmsLimitStallScheduler', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('schedules a retry at the requested interval', async () => {
    vi.useFakeTimers();
    const scheduler = new InMemorySmsLimitStallScheduler();
    const attempt = vi.fn();
    scheduler.schedule('+15552220000', attempt, 60_000);

    await vi.advanceTimersByTimeAsync(59_999);
    expect(attempt).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('replaces a previously scheduled retry for the same line', async () => {
    vi.useFakeTimers();
    const scheduler = new InMemorySmsLimitStallScheduler();
    const first = vi.fn();
    const second = vi.fn();
    scheduler.schedule('+15552220000', first, 60_000);
    scheduler.schedule('+15552220000', second, 30_000);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('cancel removes the pending retry', async () => {
    vi.useFakeTimers();
    const scheduler = new InMemorySmsLimitStallScheduler();
    const attempt = vi.fn();
    scheduler.schedule('+15552220000', attempt, 60_000);
    scheduler.cancel('+15552220000');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempt).not.toHaveBeenCalled();
  });

  it('cancelAll cancels every line', async () => {
    vi.useFakeTimers();
    const scheduler = new InMemorySmsLimitStallScheduler();
    const a = vi.fn();
    const b = vi.fn();
    scheduler.schedule('+1A', a, 60_000);
    scheduler.schedule('+1B', b, 60_000);
    scheduler.cancelAll();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
  });

  it('swallows attempt errors so a failing retry does not crash the process', async () => {
    vi.useFakeTimers();
    const scheduler = new InMemorySmsLimitStallScheduler();
    const failing = vi.fn().mockRejectedValue(new Error('transient'));
    scheduler.schedule('+15552220000', failing, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    // Drain microtasks so the rejection has somewhere to land.
    await Promise.resolve();
    expect(failing).toHaveBeenCalledTimes(1);
  });
});
