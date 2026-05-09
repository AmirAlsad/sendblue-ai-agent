import type pino from 'pino';
import type { AgentConfig } from '../config/env.js';
import type { AgentMetrics } from '../metrics/registry.js';
import { SendblueApiError } from '../sendblue/client.js';
import { classifyErrorCode } from '../status/tracker.js';
import { transientRetryDelayMs } from './retry.js';
import type { LimitCounterStore, LimitSnapshot, SmsLimitStall, SmsLimitStallEntry } from './store.js';

/**
 * Three-way classification of a Sendblue error for retry routing:
 *
 * - `transient` — `rate_limit` or `server` category. Caller retries up to
 *   `transientRetryMaxAttempts` with exponential backoff + jitter.
 * - `sms_limit` — `SMS_LIMIT_REACHED`. Caller stalls the per-line queue and
 *   retries every `smsLimitRetryIntervalMs` up to `smsLimitMaxAttempts`.
 * - `permanent` — `validation`, `blacklist`, or unknown. Caller aborts the
 *   queue (existing behavior).
 */
export type ErrorClassification = 'transient' | 'sms_limit' | 'permanent';

export type LimitTrackerConfig = Pick<
  AgentConfig,
  | 'outboundRateLimitPerSecond'
  | 'outboundRateLimitPerHour'
  | 'outboundRateLimitPerDay'
  | 'inboundContactsPerDayWarnThreshold'
  | 'inboundContactsPerDayLimit'
  | 'followUpDailyWarnThreshold'
  | 'followUpDailyLimit'
  | 'replyWindowHours'
  | 'transientRetryMaxAttempts'
  | 'transientRetryBaseMs'
  | 'transientRetryMaxMs'
  | 'smsLimitMaxAttempts'
>;

export type LimitTracker = {
  /**
   * Pre-emptive 1/s gate. Awaits any required delay internally so callers
   * just `await acquireSendSlot(line)` before sending.
   */
  acquireSendSlot(lineNumber: string): Promise<void>;

  recordOutbound(args: { lineNumber: string; phoneNumber: string; lastInboundAt?: string }): Promise<void>;
  recordInbound(args: { lineNumber: string; phoneNumber: string; receivedAt: string }): Promise<void>;
  isWithinReplyWindow(lineNumber: string, phoneNumber: string): Promise<boolean>;

  classifyError(error: unknown): ErrorClassification;
  /**
   * Classify a Sendblue documented error code (string from status callback
   * or response body). Mirrors `classifyError` but takes the bare string
   * since status callbacks do not carry an exception object.
   */
  classifyStatusErrorCode(errorCode: string | undefined | null): ErrorClassification;
  retryDelayMs(attempt: number): number;
  transientRetryMaxAttempts(): number;
  smsLimitMaxAttempts(): number;

  /**
   * Pass-throughs to the underlying `LimitCounterStore` for SMS-stall
   * persistence. `getSmsLimitStall` returns `undefined` when no stall is
   * active for `lineNumber`; `setSmsLimitStall` upserts the stall metadata
   * (including `conversationKey` so a boot-time recovery can re-arm the
   * timer); `clearSmsLimitStall` clears persistence after the stall is
   * resolved (e.g. on the next successful DELIVERED/SENT, or on
   * `interruptSending` when a fresh inbound takes over).
   */
  getSmsLimitStall(lineNumber: string): Promise<SmsLimitStall | undefined>;
  setSmsLimitStall(lineNumber: string, stall: SmsLimitStall): Promise<void>;
  clearSmsLimitStall(lineNumber: string): Promise<void>;
  listSmsLimitStalls(): Promise<SmsLimitStallEntry[]>;

  snapshot(lineNumber: string, now?: Date): Promise<LimitSnapshot>;
};

export type LimitTrackerDeps = {
  config: LimitTrackerConfig;
  store: LimitCounterStore;
  logger: pino.Logger;
  metrics?: AgentMetrics;
  /** Override the clock in tests. */
  now?: () => Date;
  /** Override the sleep impl (defaults to setTimeout) for tests. */
  sleep?: (ms: number) => Promise<void>;
};

export function createLimitTracker(deps: LimitTrackerDeps): LimitTracker {
  const now = (): Date => deps.now?.() ?? new Date();
  const sleep =
    deps.sleep ??
    ((ms: number) =>
      new Promise<void>(resolve => {
        if (ms <= 0) resolve();
        else setTimeout(resolve, ms);
      }));

  return {
    async acquireSendSlot(lineNumber: string): Promise<void> {
      const { delayMs } = await deps.store.acquireOutboundSlot(
        lineNumber,
        now(),
        deps.config.outboundRateLimitPerSecond
      );
      deps.metrics?.acquireSendSlotDelay.observe({ line_number: lineNumber }, delayMs / 1000);
      if (delayMs > 0) await sleep(delayMs);
    },

    async recordOutbound({ lineNumber, phoneNumber, lastInboundAt }): Promise<void> {
      const sentAt = now();
      const withinReplyWindow = isWithinWindow(lastInboundAt, sentAt, deps.config.replyWindowHours);
      const result = await deps.store.recordOutbound({
        lineNumber,
        phoneNumber,
        withinReplyWindow,
        now: sentAt
      });
      // Hour and day thresholds are warned at 80% and surfaced at error when
      // crossed. Sendblue's 1500-message queue cap → 429 happens before the
      // hour limit fires, so we want operators to see hour pressure early.
      const hourWarn = Math.floor(deps.config.outboundRateLimitPerHour * 0.8);
      if (result.hourCount === hourWarn) {
        deps.metrics?.limitThresholdCrossings.inc({ kind: 'outbound_hour', level: 'warn' });
        deps.logger.warn(
          { lineNumber, hourCount: result.hourCount, hourLimit: deps.config.outboundRateLimitPerHour },
          'agent-plan outbound hourly count reached 80% warning threshold'
        );
      }
      if (result.hourCount === deps.config.outboundRateLimitPerHour) {
        deps.metrics?.limitThresholdCrossings.inc({ kind: 'outbound_hour', level: 'limit' });
        deps.logger.error(
          { lineNumber, hourCount: result.hourCount },
          'agent-plan outbound hourly limit reached'
        );
      }
      const dayWarn = Math.floor(deps.config.outboundRateLimitPerDay * 0.8);
      if (result.dayCount === dayWarn) {
        deps.metrics?.limitThresholdCrossings.inc({ kind: 'outbound_day', level: 'warn' });
        deps.logger.warn(
          { lineNumber, dayCount: result.dayCount, dayLimit: deps.config.outboundRateLimitPerDay },
          'agent-plan outbound daily count reached 80% warning threshold'
        );
      }
      if (result.dayCount === deps.config.outboundRateLimitPerDay) {
        deps.metrics?.limitThresholdCrossings.inc({ kind: 'outbound_day', level: 'limit' });
        deps.logger.error(
          { lineNumber, dayCount: result.dayCount },
          'agent-plan outbound daily limit reached'
        );
      }
      if (!withinReplyWindow) {
        if (result.followUpsToday === deps.config.followUpDailyWarnThreshold) {
          deps.metrics?.limitThresholdCrossings.inc({ kind: 'followup', level: 'warn' });
          deps.logger.warn(
            {
              lineNumber,
              followUpsToday: result.followUpsToday,
              warnThreshold: deps.config.followUpDailyWarnThreshold,
              limit: deps.config.followUpDailyLimit
            },
            'agent-plan follow-up daily count reached warn threshold'
          );
        }
        if (result.followUpsToday === deps.config.followUpDailyLimit) {
          deps.metrics?.limitThresholdCrossings.inc({ kind: 'followup', level: 'limit' });
          deps.logger.error(
            { lineNumber, followUpsToday: result.followUpsToday, limit: deps.config.followUpDailyLimit },
            'agent-plan follow-up daily count reached documented limit (track-only — sends are not gated)'
          );
        }
      }
    },

    async recordInbound({ lineNumber, phoneNumber, receivedAt }): Promise<void> {
      const at = new Date(receivedAt);
      await deps.store.setLastInboundAt(lineNumber, phoneNumber, at);
      const result = await deps.store.recordInbound(lineNumber, phoneNumber, at);
      if (result.firstSeenToday) {
        if (result.distinctToday === deps.config.inboundContactsPerDayWarnThreshold) {
          deps.metrics?.limitThresholdCrossings.inc({ kind: 'inbound_distinct', level: 'warn' });
          deps.logger.warn(
            {
              lineNumber,
              distinctToday: result.distinctToday,
              warnThreshold: deps.config.inboundContactsPerDayWarnThreshold,
              limit: deps.config.inboundContactsPerDayLimit
            },
            'agent-plan distinct-inbound count reached warn threshold'
          );
        }
        if (result.distinctToday === deps.config.inboundContactsPerDayLimit) {
          deps.metrics?.limitThresholdCrossings.inc({ kind: 'inbound_distinct', level: 'limit' });
          deps.logger.error(
            {
              lineNumber,
              distinctToday: result.distinctToday,
              limit: deps.config.inboundContactsPerDayLimit
            },
            'agent-plan distinct-inbound daily limit reached'
          );
        }
      }
    },

    async isWithinReplyWindow(lineNumber: string, phoneNumber: string): Promise<boolean> {
      const last = await deps.store.getLastInboundAt(lineNumber, phoneNumber);
      return isWithinWindow(last?.toISOString(), now(), deps.config.replyWindowHours);
    },

    classifyError(error: unknown): ErrorClassification {
      if (!(error instanceof SendblueApiError)) {
        // Network / DNS / parse errors are treated as transient — the queue
        // gets bounded retries rather than aborting on a single hiccup.
        return 'transient';
      }
      const fromCode = classifyStatusErrorCode(error.errorCode);
      if (fromCode !== 'permanent') return fromCode;
      // `httpStatus === 0` means the request failed before a response (DNS,
      // socket reset, abort) per `SendblueApiError` docs. 429 / 5xx are also
      // retryable transient conditions.
      if (
        error.httpStatus === 0 ||
        error.httpStatus === 429 ||
        (error.httpStatus >= 500 && error.httpStatus < 600)
      ) {
        return 'transient';
      }
      return 'permanent';
    },

    classifyStatusErrorCode(errorCode: string | undefined | null): ErrorClassification {
      return classifyStatusErrorCode(errorCode);
    },

    retryDelayMs(attempt: number): number {
      return transientRetryDelayMs(
        attempt,
        deps.config.transientRetryBaseMs,
        deps.config.transientRetryMaxMs
      );
    },

    transientRetryMaxAttempts(): number {
      return deps.config.transientRetryMaxAttempts;
    },

    smsLimitMaxAttempts(): number {
      return deps.config.smsLimitMaxAttempts;
    },

    getSmsLimitStall(lineNumber: string): Promise<SmsLimitStall | undefined> {
      return deps.store.getSmsLimitStall(lineNumber);
    },

    setSmsLimitStall(lineNumber: string, stall: SmsLimitStall): Promise<void> {
      return deps.store.setSmsLimitStall(lineNumber, stall);
    },

    clearSmsLimitStall(lineNumber: string): Promise<void> {
      return deps.store.clearSmsLimitStall(lineNumber);
    },

    listSmsLimitStalls(): Promise<SmsLimitStallEntry[]> {
      return deps.store.listSmsLimitStalls();
    },

    async snapshot(lineNumber: string, when?: Date): Promise<LimitSnapshot> {
      return deps.store.snapshot(lineNumber, when ?? now());
    }
  };
}

function classifyStatusErrorCode(errorCode: string | number | undefined | null): ErrorClassification {
  const category = classifyErrorCode(errorCode);
  if (category === 'sms_limit') return 'sms_limit';
  if (category === 'rate_limit' || category === 'server' || category === 'status_unresolved') {
    return 'transient';
  }
  return 'permanent';
}

function isWithinWindow(lastInboundAt: string | Date | undefined, sentAt: Date, windowHours: number): boolean {
  if (!lastInboundAt) return false;
  if (windowHours <= 0) return true;
  const last = lastInboundAt instanceof Date ? lastInboundAt : new Date(lastInboundAt);
  if (Number.isNaN(last.getTime())) return false;
  const ageMs = sentAt.getTime() - last.getTime();
  return ageMs >= 0 && ageMs <= windowHours * 3600 * 1000;
}
