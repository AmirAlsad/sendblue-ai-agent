import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { SendblueApiError } from '../../src/sendblue/client.js';
import { InMemoryLimitCounterStore } from '../../src/limits/store.js';
import { createLimitTracker, type LimitTrackerConfig } from '../../src/limits/tracker.js';

const LINE = '+15552220000';
const NUMBER = '+15551110001';

function baseConfig(overrides: Partial<LimitTrackerConfig> = {}): LimitTrackerConfig {
  return {
    outboundRateLimitPerSecond: 1,
    outboundRateLimitPerHour: 2000,
    outboundRateLimitPerDay: 4000,
    inboundContactsPerDayWarnThreshold: 800,
    inboundContactsPerDayLimit: 1000,
    followUpDailyWarnThreshold: 160,
    followUpDailyLimit: 200,
    replyWindowHours: 24,
    transientRetryMaxAttempts: 3,
    transientRetryBaseMs: 1000,
    transientRetryMaxMs: 60000,
    smsLimitMaxAttempts: 24,
    ...overrides
  };
}

function makeTracker(overrides: Partial<LimitTrackerConfig> = {}, sleep?: (ms: number) => Promise<void>) {
  const store = new InMemoryLimitCounterStore();
  const logs: { level: string; payload: Record<string, unknown>; msg: string }[] = [];
  const logger = pino(
    {
      level: 'debug',
      timestamp: false
    },
    {
      write: (chunk: string) => {
        try {
          const parsed = JSON.parse(chunk) as Record<string, unknown>;
          logs.push({
            level: typeof parsed.level === 'number' ? String(parsed.level) : 'unknown',
            payload: parsed,
            msg: typeof parsed.msg === 'string' ? parsed.msg : ''
          });
        } catch {
          // ignore non-JSON
        }
      }
    } as unknown as pino.DestinationStream
  );
  const tracker = createLimitTracker({ config: baseConfig(overrides), store, logger, sleep });
  return { tracker, store, logs };
}

describe('createLimitTracker', () => {
  it('classifies a 5509 SendblueApiError as transient', () => {
    const { tracker } = makeTracker();
    const err = new SendblueApiError({
      operation: 'send-message',
      httpStatus: 429,
      errorCode: '5509',
      responseBody: null,
      message: 'rate limit'
    });
    expect(tracker.classifyError(err)).toBe('transient');
  });

  it('classifies SMS_LIMIT_REACHED as sms_limit', () => {
    const { tracker } = makeTracker();
    const err = new SendblueApiError({
      operation: 'send-message',
      httpStatus: 200,
      errorCode: 'SMS_LIMIT_REACHED',
      responseBody: null,
      message: 'sms cap'
    });
    expect(tracker.classifyError(err)).toBe('sms_limit');
  });

  it('classifies validation 4000 as permanent', () => {
    const { tracker } = makeTracker();
    const err = new SendblueApiError({
      operation: 'send-message',
      httpStatus: 400,
      errorCode: '4000',
      responseBody: null,
      message: 'bad number'
    });
    expect(tracker.classifyError(err)).toBe('permanent');
  });

  it('classifies generic Error (network/transport) as transient', () => {
    const { tracker } = makeTracker();
    expect(tracker.classifyError(new Error('fetch failed'))).toBe('transient');
  });

  it('classifies bare 429 / 5xx without errorCode as transient', () => {
    const { tracker } = makeTracker();
    const e429 = new SendblueApiError({
      operation: 'send-message',
      httpStatus: 429,
      responseBody: null,
      message: 'too many'
    });
    const e503 = new SendblueApiError({
      operation: 'send-message',
      httpStatus: 503,
      responseBody: null,
      message: 'unavailable'
    });
    expect(tracker.classifyError(e429)).toBe('transient');
    expect(tracker.classifyError(e503)).toBe('transient');
  });

  it('classifies httpStatus=0 (network failure before response) as transient', () => {
    const { tracker } = makeTracker();
    const networkErr = new SendblueApiError({
      operation: 'send-message',
      httpStatus: 0,
      responseBody: null,
      message: 'fetch failed'
    });
    expect(tracker.classifyError(networkErr)).toBe('transient');
  });

  it('paces the second send via acquireSendSlot (first goes immediately, second sleeps)', async () => {
    const sleeps: number[] = [];
    const { tracker } = makeTracker({}, async ms => {
      sleeps.push(ms);
    });
    await tracker.acquireSendSlot(LINE);
    await tracker.acquireSendSlot(LINE);
    // The first call's delay was 0 (no sleep recorded). The second sleeps.
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThan(0);
    expect(sleeps[0]).toBeLessThanOrEqual(1000);
  });

  it('classifies in-window vs follow-up via lastInboundAt', async () => {
    const { tracker } = makeTracker({ replyWindowHours: 24 });
    const now = new Date();
    const recent = new Date(now.getTime() - 60_000).toISOString();
    const stale = new Date(now.getTime() - 25 * 3600 * 1000).toISOString();

    await tracker.recordOutbound({ lineNumber: LINE, phoneNumber: NUMBER, lastInboundAt: recent });
    await tracker.recordOutbound({ lineNumber: LINE, phoneNumber: NUMBER, lastInboundAt: stale });
    await tracker.recordOutbound({ lineNumber: LINE, phoneNumber: NUMBER, lastInboundAt: undefined });
    const snap = await tracker.snapshot(LINE);
    expect(snap.followUpsToday).toBe(2);
  });

  it('logs warn at the inbound-distinct warn threshold', async () => {
    const { tracker, logs } = makeTracker({
      inboundContactsPerDayWarnThreshold: 2,
      inboundContactsPerDayLimit: 3
    });
    await tracker.recordInbound({ lineNumber: LINE, phoneNumber: '+15551110001', receivedAt: new Date().toISOString() });
    await tracker.recordInbound({ lineNumber: LINE, phoneNumber: '+15551110002', receivedAt: new Date().toISOString() });
    const warned = logs.find(l => l.msg.includes('distinct-inbound count reached warn threshold'));
    expect(warned).toBeDefined();
  });

  it('logs error when the inbound-distinct daily limit is hit', async () => {
    const { tracker, logs } = makeTracker({
      inboundContactsPerDayWarnThreshold: 1,
      inboundContactsPerDayLimit: 2
    });
    await tracker.recordInbound({ lineNumber: LINE, phoneNumber: '+15551110001', receivedAt: new Date().toISOString() });
    await tracker.recordInbound({ lineNumber: LINE, phoneNumber: '+15551110002', receivedAt: new Date().toISOString() });
    const errored = logs.find(l => l.msg.includes('distinct-inbound daily limit reached'));
    expect(errored).toBeDefined();
  });

  it('exposes retryDelayMs(attempt) with bounded backoff', () => {
    const { tracker } = makeTracker();
    expect(tracker.retryDelayMs(1)).toBeGreaterThanOrEqual(800);
    expect(tracker.retryDelayMs(1)).toBeLessThanOrEqual(1200);
    expect(tracker.retryDelayMs(3)).toBeGreaterThanOrEqual(12800);
    expect(tracker.retryDelayMs(3)).toBeLessThanOrEqual(19200);
  });

  it('isWithinReplyWindow returns true for recent inbound, false after window expires', async () => {
    const { tracker, store } = makeTracker({ replyWindowHours: 24 });
    const now = new Date();
    await store.setLastInboundAt(LINE, NUMBER, new Date(now.getTime() - 60_000));
    expect(await tracker.isWithinReplyWindow(LINE, NUMBER)).toBe(true);

    await store.setLastInboundAt(LINE, NUMBER, new Date(now.getTime() - 25 * 3600 * 1000));
    expect(await tracker.isWithinReplyWindow(LINE, NUMBER)).toBe(false);

    expect(await tracker.isWithinReplyWindow(LINE, '+15551110099')).toBe(false);
  });
});
