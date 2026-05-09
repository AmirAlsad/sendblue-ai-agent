/**
 * Per-line limit counters used by `LimitTracker` to pre-emptively pace
 * outbound sends, classify in-window vs follow-up, and surface telemetry to
 * the operator. Two implementations live alongside this interface:
 *
 * - {@link InMemoryLimitCounterStore} — Maps with timestamp-based TTL. Single
 *   process only. Suitable for unit/integration tests and dev runs.
 * - {@link "./redis-store.js".RedisLimitCounterStore} — Redis-backed
 *   counters using `INCR`/`EXPIRE` for time windows, `SADD` for distinct
 *   inbound numbers. Required for multi-replica deploys (the in-memory
 *   pacer overshoots the 1/s rate when there are N replicas).
 */

export type LimitSnapshot = {
  lineNumber: string;
  outbound: {
    /** Outbound sends counted in the current 1-second slot. */
    secondCount: number;
    /** Outbound sends counted in the current hour. */
    hourCount: number;
    /** Outbound sends counted in the current day (UTC). */
    dayCount: number;
  };
  /** Distinct inbound from-numbers seen today (UTC), per line. */
  inboundContactsToday: number;
  /** Out-of-window outbound sends today (UTC), per line. */
  followUpsToday: number;
  /** ISO timestamp; present when an SMS_LIMIT_REACHED stall is active. */
  smsLimitNextRetryAt?: string;
  /** Number of stall retries already attempted in the active stall. */
  smsLimitStallAttempts: number;
};

export type AcquireOutboundSlotResult = {
  /** Milliseconds the caller should wait before sending. 0 means go now. */
  delayMs: number;
};

export type RecordOutboundResult = {
  secondCount: number;
  hourCount: number;
  dayCount: number;
  followUpsToday: number;
};

export type RecordInboundResult = {
  distinctToday: number;
  /** True when this is the first inbound from this number today. */
  firstSeenToday: boolean;
};

/**
 * SMS_LIMIT_REACHED stall metadata persisted across the LimitCounterStore.
 *
 * `conversationKey` ties the stall to the per-conversation outbound queue
 * that triggered it, so a boot-time recovery in a fresh process can re-arm
 * the in-memory `SmsLimitStallScheduler` and call `runRetry(conversationKey)`
 * with the right target.
 */
export type SmsLimitStall = {
  attempts: number;
  nextRetryAt: Date;
  conversationKey: string;
};

/** Stall + the line it belongs to, returned by `listSmsLimitStalls`. */
export type SmsLimitStallEntry = SmsLimitStall & { lineNumber: string };

export type LimitCounterStore = {
  /**
   * Token-bucket gate for the per-line outbound rate. Returns the number of
   * milliseconds the caller should wait before performing the send. The
   * caller is expected to actually wait (`setTimeout`/`Promise`) — the store
   * does not block internally.
   *
   * Stores update their internal `lastAcquiredAt` to `max(now, lastSlot +
   * 1000/perSecond)`, so a long pause does not accumulate burst credits.
   */
  acquireOutboundSlot(
    lineNumber: string,
    now: Date,
    perSecond: number
  ): Promise<AcquireOutboundSlotResult>;

  /** Increment per-line outbound counters; bumps follow-up counter if `withinReplyWindow` is false. */
  recordOutbound(args: {
    lineNumber: string;
    phoneNumber: string;
    withinReplyWindow: boolean;
    now: Date;
  }): Promise<RecordOutboundResult>;

  /** Add the (line, phone) to today's distinct-inbound set; returns whether this was the first. */
  recordInbound(lineNumber: string, phoneNumber: string, now: Date): Promise<RecordInboundResult>;

  /** Persist `last_inbound_at` for 24h-reply-window classification. */
  setLastInboundAt(lineNumber: string, phoneNumber: string, when: Date): Promise<void>;

  /** Read `last_inbound_at`; undefined when no inbound has been recorded. */
  getLastInboundAt(lineNumber: string, phoneNumber: string): Promise<Date | undefined>;

  /**
   * SMS_LIMIT_REACHED stall metadata. The store persists the active retry
   * schedule per line so the controller can resume after process restarts
   * (when Redis is configured). Returns `undefined` when no stall is active.
   */
  getSmsLimitStall(lineNumber: string): Promise<SmsLimitStall | undefined>;
  setSmsLimitStall(lineNumber: string, stall: SmsLimitStall): Promise<void>;
  clearSmsLimitStall(lineNumber: string): Promise<void>;
  /**
   * Enumerate every active SMS-limit stall. Used by `recoverPendingRetries`
   * at boot to re-arm `SmsLimitStallScheduler` timers for stalls that were
   * persisted but whose in-process timer was lost on restart.
   */
  listSmsLimitStalls(): Promise<SmsLimitStallEntry[]>;

  /** Read-only snapshot for `/admin/limits` and tests. */
  snapshot(lineNumber: string, now: Date): Promise<LimitSnapshot>;

  close?(): Promise<void>;
};

type Bucket = { value: number; expiresAt: number };
type StringSet = { values: Set<string>; expiresAt: number };

function utcDayKey(date: Date): string {
  return `${date.getUTCFullYear()}-${date.getUTCMonth() + 1}-${date.getUTCDate()}`;
}

function utcHourKey(date: Date): string {
  return `${utcDayKey(date)}-${date.getUTCHours()}`;
}

export class InMemoryLimitCounterStore implements LimitCounterStore {
  private readonly outboundSecondSlots = new Map<string, number>();
  private readonly outboundHourCounters = new Map<string, Bucket>();
  private readonly outboundDayCounters = new Map<string, Bucket>();
  private readonly outboundSecondCounters = new Map<string, Bucket>();
  private readonly inboundDistinct = new Map<string, StringSet>();
  private readonly followUpDayCounters = new Map<string, Bucket>();
  private readonly lastInboundAt = new Map<string, number>();
  private readonly smsLimitStalls = new Map<string, { attempts: number; nextRetryAt: number; conversationKey: string }>();

  async acquireOutboundSlot(
    lineNumber: string,
    now: Date,
    perSecond: number
  ): Promise<AcquireOutboundSlotResult> {
    if (perSecond <= 0) return { delayMs: 0 };
    const intervalMs = 1000 / perSecond;
    const last = this.outboundSecondSlots.get(lineNumber) ?? 0;
    const nowMs = now.getTime();
    const nextAvailable = last + intervalMs;
    const slot = Math.max(nowMs, nextAvailable);
    this.outboundSecondSlots.set(lineNumber, slot);
    return { delayMs: Math.max(0, slot - nowMs) };
  }

  async recordOutbound(args: {
    lineNumber: string;
    phoneNumber: string;
    withinReplyWindow: boolean;
    now: Date;
  }): Promise<RecordOutboundResult> {
    const nowMs = args.now.getTime();
    const secondCount = this.bumpBucket(
      this.outboundSecondCounters,
      `${args.lineNumber}:${Math.floor(nowMs / 1000)}`,
      nowMs + 1000,
      nowMs
    );
    const hourCount = this.bumpBucket(
      this.outboundHourCounters,
      `${args.lineNumber}:${utcHourKey(args.now)}`,
      nowMs + 3600 * 1000,
      nowMs
    );
    const dayCount = this.bumpBucket(
      this.outboundDayCounters,
      `${args.lineNumber}:${utcDayKey(args.now)}`,
      nowMs + 86400 * 1000,
      nowMs
    );
    const followUpsToday = args.withinReplyWindow
      ? this.peekBucket(this.followUpDayCounters, `${args.lineNumber}:${utcDayKey(args.now)}`, nowMs)
      : this.bumpBucket(
          this.followUpDayCounters,
          `${args.lineNumber}:${utcDayKey(args.now)}`,
          nowMs + 86400 * 1000,
          nowMs
        );
    return { secondCount, hourCount, dayCount, followUpsToday };
  }

  async recordInbound(
    lineNumber: string,
    phoneNumber: string,
    now: Date
  ): Promise<RecordInboundResult> {
    const nowMs = now.getTime();
    const key = `${lineNumber}:${utcDayKey(now)}`;
    const expiresAt = nowMs + 86400 * 1000;
    let bucket = this.inboundDistinct.get(key);
    if (!bucket || bucket.expiresAt <= nowMs) {
      bucket = { values: new Set(), expiresAt };
      this.inboundDistinct.set(key, bucket);
    }
    const firstSeen = !bucket.values.has(phoneNumber);
    if (firstSeen) bucket.values.add(phoneNumber);
    return { distinctToday: bucket.values.size, firstSeenToday: firstSeen };
  }

  async setLastInboundAt(lineNumber: string, phoneNumber: string, when: Date): Promise<void> {
    this.lastInboundAt.set(`${lineNumber}:${phoneNumber}`, when.getTime());
  }

  async getLastInboundAt(lineNumber: string, phoneNumber: string): Promise<Date | undefined> {
    const ms = this.lastInboundAt.get(`${lineNumber}:${phoneNumber}`);
    return ms === undefined ? undefined : new Date(ms);
  }

  async getSmsLimitStall(lineNumber: string): Promise<SmsLimitStall | undefined> {
    const stall = this.smsLimitStalls.get(lineNumber);
    if (!stall) return undefined;
    return {
      attempts: stall.attempts,
      nextRetryAt: new Date(stall.nextRetryAt),
      conversationKey: stall.conversationKey
    };
  }

  async setSmsLimitStall(lineNumber: string, stall: SmsLimitStall): Promise<void> {
    this.smsLimitStalls.set(lineNumber, {
      attempts: stall.attempts,
      nextRetryAt: stall.nextRetryAt.getTime(),
      conversationKey: stall.conversationKey
    });
  }

  async clearSmsLimitStall(lineNumber: string): Promise<void> {
    this.smsLimitStalls.delete(lineNumber);
  }

  async listSmsLimitStalls(): Promise<SmsLimitStallEntry[]> {
    return Array.from(this.smsLimitStalls.entries()).map(([lineNumber, stall]) => ({
      lineNumber,
      attempts: stall.attempts,
      nextRetryAt: new Date(stall.nextRetryAt),
      conversationKey: stall.conversationKey
    }));
  }

  async snapshot(lineNumber: string, now: Date): Promise<LimitSnapshot> {
    const stall = this.smsLimitStalls.get(lineNumber);
    const nowMs = now.getTime();
    const inboundBucket = this.inboundDistinct.get(`${lineNumber}:${utcDayKey(now)}`);
    return {
      lineNumber,
      outbound: {
        secondCount: this.peekBucket(
          this.outboundSecondCounters,
          `${lineNumber}:${Math.floor(nowMs / 1000)}`,
          nowMs
        ),
        hourCount: this.peekBucket(
          this.outboundHourCounters,
          `${lineNumber}:${utcHourKey(now)}`,
          nowMs
        ),
        dayCount: this.peekBucket(
          this.outboundDayCounters,
          `${lineNumber}:${utcDayKey(now)}`,
          nowMs
        )
      },
      inboundContactsToday: inboundBucket && inboundBucket.expiresAt > nowMs ? inboundBucket.values.size : 0,
      followUpsToday: this.peekBucket(
        this.followUpDayCounters,
        `${lineNumber}:${utcDayKey(now)}`,
        nowMs
      ),
      smsLimitStallAttempts: stall?.attempts ?? 0,
      smsLimitNextRetryAt: stall ? new Date(stall.nextRetryAt).toISOString() : undefined
    };
  }

  private bumpBucket(map: Map<string, Bucket>, key: string, expiresAt: number, nowMs: number): number {
    let bucket = map.get(key);
    if (!bucket || bucket.expiresAt <= nowMs) {
      bucket = { value: 0, expiresAt };
      map.set(key, bucket);
    }
    bucket.value += 1;
    return bucket.value;
  }

  private peekBucket(map: Map<string, Bucket>, key: string, nowMs: number): number {
    const bucket = map.get(key);
    if (!bucket || bucket.expiresAt <= nowMs) return 0;
    return bucket.value;
  }
}
