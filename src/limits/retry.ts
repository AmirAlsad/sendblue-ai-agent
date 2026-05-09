/**
 * Compute the delay (ms) before the next transient-error retry attempt.
 *
 * Schedule (with `baseMs=1000`, `maxMs=60000`):
 *   attempt 1 → ~1s   (jittered ±20%)
 *   attempt 2 → ~4s
 *   attempt 3 → ~16s
 *   attempt 4 → 60s   (capped)
 *
 * Jitter is multiplicative ±20% to avoid thundering-herd on rate-limit
 * boundaries when multiple conversations all hit 5509 at once.
 */
export function transientRetryDelayMs(
  attempt: number,
  baseMs: number,
  maxMs: number,
  random: () => number = Math.random
): number {
  if (attempt < 1) return 0;
  const exponent = attempt - 1;
  const raw = Math.min(maxMs, baseMs * Math.pow(4, exponent));
  // Jitter in [0.8, 1.2). Don't let jitter push the result above maxMs.
  const jitter = 0.8 + random() * 0.4;
  return Math.min(maxMs, Math.round(raw * jitter));
}

export type SmsLimitStallScheduler = {
  /**
   * Schedule a retry for the given line. Calls `attempt()` after
   * `intervalMs`. Replaces any previously scheduled retry for the same line.
   * Returns the scheduled timestamp (ms) for telemetry.
   */
  schedule(lineNumber: string, attempt: () => void | Promise<void>, intervalMs: number): number;
  /** Cancel any pending retry for this line. */
  cancel(lineNumber: string): void;
  /** Cancel all pending retries (for shutdown). */
  cancelAll(): void;
};

/**
 * Per-process scheduler for SMS_LIMIT_REACHED queue stalls. The Sendblue
 * documentation does not specify the exact reset window for the per-line
 * SMS limit, so the controller polls every `intervalMs` (default 1h) up to
 * `maxAttempts` (default 24).
 *
 * Persistence of the active stall (so it survives restarts) lives on the
 * `LimitCounterStore` — this scheduler only owns the in-process timer.
 */
export class InMemorySmsLimitStallScheduler implements SmsLimitStallScheduler {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  schedule(lineNumber: string, attempt: () => void | Promise<void>, intervalMs: number): number {
    this.cancel(lineNumber);
    const at = Date.now() + intervalMs;
    const timer = setTimeout(() => {
      this.timers.delete(lineNumber);
      Promise.resolve(attempt()).catch(() => {
        // Caller is responsible for logging; do not crash the process.
      });
    }, intervalMs);
    this.timers.set(lineNumber, timer);
    return at;
  }

  cancel(lineNumber: string): void {
    const timer = this.timers.get(lineNumber);
    if (timer) clearTimeout(timer);
    this.timers.delete(lineNumber);
  }

  cancelAll(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
