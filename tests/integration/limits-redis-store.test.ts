// Smoke test for RedisLimitCounterStore.
//
// Skipped by default. To run, point `TEST_REDIS_URL` at a real Redis
// instance — e.g. `TEST_REDIS_URL=redis://localhost:6379/15 npm run test:integration`.
// The test uses DB 15 by convention so a stray run cannot clobber app
// data on the default DB 0; FLUSHDB still runs between tests so the run
// is destructive on whatever DB is selected. Do not point this at a
// production Redis.
//
// Verifies the Lua-managed pacing slot, INCR/EXPIRE counters, SADD/SCARD
// distinct-inbound set, last_inbound_at SET, and the SMS-stall metadata
// JSON round-trip.

import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RedisLimitCounterStore } from '../../src/limits/redis-store.js';
import { testConfig } from '../helpers/config.js';

const TEST_REDIS_URL = process.env.TEST_REDIS_URL;
const describeOrSkip = TEST_REDIS_URL ? describe : describe.skip;

describeOrSkip('RedisLimitCounterStore (live Redis)', () => {
  let redis: Redis;
  let store: RedisLimitCounterStore;
  const LINE = `+1555TEST${Math.floor(Math.random() * 1_000_000)
    .toString()
    .padStart(6, '0')}`;
  const NUMBER = '+15551110001';

  beforeAll(async () => {
    redis = new Redis(TEST_REDIS_URL!, { maxRetriesPerRequest: null });
    // Sanity-ping so failures surface as clear assertion errors rather than
    // hanging operations later.
    const pong = await redis.ping();
    expect(pong).toBe('PONG');
  });

  afterAll(async () => {
    await redis.quit();
  });

  beforeEach(async () => {
    await redis.flushdb();
    store = new RedisLimitCounterStore(testConfig({ redisUrl: TEST_REDIS_URL! }), redis);
  });

  afterEach(async () => {
    await redis.flushdb();
  });

  it('acquireOutboundSlot returns 0 on the first call and paces the second by ~interval', async () => {
    const t0 = new Date('2026-05-09T00:00:00.000Z');
    const r1 = await store.acquireOutboundSlot(LINE, t0, 1);
    expect(r1.delayMs).toBe(0);

    // 250ms later: must wait until t0+1000.
    const t1 = new Date(t0.getTime() + 250);
    const r2 = await store.acquireOutboundSlot(LINE, t1, 1);
    expect(r2.delayMs).toBe(750);

    // Long after the first slot: 0 delay again.
    const t2 = new Date(t0.getTime() + 5000);
    const r3 = await store.acquireOutboundSlot(LINE, t2, 1);
    expect(r3.delayMs).toBe(0);
  });

  it('acquireOutboundSlot stays atomic under concurrent calls (Lua EVAL)', async () => {
    const now = new Date('2026-05-09T00:00:00.000Z');
    // Fire 10 acquires "concurrently" at the same now; the slots should
    // serialize so the cumulative delay across all of them is ~ (n-1) × 1000.
    const results = await Promise.all(
      Array.from({ length: 10 }, () => store.acquireOutboundSlot(LINE, now, 1))
    );
    const delays = results.map(r => r.delayMs).sort((a, b) => a - b);
    // First slot: 0; subsequent: 1000, 2000, … 9000.
    expect(delays).toEqual([0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000]);
  });

  it('treats perSecond <= 0 as no pacing', async () => {
    const r = await store.acquireOutboundSlot(LINE, new Date(), 0);
    expect(r.delayMs).toBe(0);
  });

  it('recordOutbound bumps second/hour/day counters and follow-up bucket only when out of window', async () => {
    const now = new Date('2026-05-09T12:00:00.000Z');
    const inWindow = await store.recordOutbound({
      lineNumber: LINE,
      phoneNumber: NUMBER,
      withinReplyWindow: true,
      now
    });
    expect(inWindow).toMatchObject({
      secondCount: 1,
      hourCount: 1,
      dayCount: 1,
      followUpsToday: 0
    });

    const followUp = await store.recordOutbound({
      lineNumber: LINE,
      phoneNumber: NUMBER,
      withinReplyWindow: false,
      now
    });
    expect(followUp).toMatchObject({
      secondCount: 2,
      hourCount: 2,
      dayCount: 2,
      followUpsToday: 1
    });

    const followUp2 = await store.recordOutbound({
      lineNumber: LINE,
      phoneNumber: NUMBER,
      withinReplyWindow: false,
      now
    });
    expect(followUp2.followUpsToday).toBe(2);
  });

  it('recordInbound returns firstSeenToday=true once per (line, number, day)', async () => {
    const now = new Date('2026-05-09T00:00:00.000Z');
    const r1 = await store.recordInbound(LINE, NUMBER, now);
    expect(r1).toEqual({ distinctToday: 1, firstSeenToday: true });

    const r2 = await store.recordInbound(LINE, NUMBER, now);
    expect(r2).toEqual({ distinctToday: 1, firstSeenToday: false });

    const r3 = await store.recordInbound(LINE, '+15551110002', now);
    expect(r3).toEqual({ distinctToday: 2, firstSeenToday: true });
  });

  it('persists and reads last_inbound_at via SET/GET with ISO encoding', async () => {
    const when = new Date('2026-05-09T12:34:56.000Z');
    await store.setLastInboundAt(LINE, NUMBER, when);
    const got = await store.getLastInboundAt(LINE, NUMBER);
    expect(got?.toISOString()).toBe(when.toISOString());

    const missing = await store.getLastInboundAt(LINE, '+15551110099');
    expect(missing).toBeUndefined();
  });

  it('round-trips SMS-limit stall metadata as JSON with conversationKey', async () => {
    const next = new Date('2026-05-09T13:00:00.000Z');
    const conversationKey = `direct:${LINE}:${NUMBER}`;
    await store.setSmsLimitStall(LINE, { attempts: 3, nextRetryAt: next, conversationKey });
    const got = await store.getSmsLimitStall(LINE);
    expect(got?.attempts).toBe(3);
    expect(got?.nextRetryAt.toISOString()).toBe(next.toISOString());
    expect(got?.conversationKey).toBe(conversationKey);

    await store.clearSmsLimitStall(LINE);
    expect(await store.getSmsLimitStall(LINE)).toBeUndefined();
  });

  it('listSmsLimitStalls enumerates every active stall via SCAN', async () => {
    const next = new Date('2026-05-09T13:00:00.000Z');
    await store.setSmsLimitStall('+1AAA111', { attempts: 1, nextRetryAt: next, conversationKey: 'direct:+1AAA111:+1X' });
    await store.setSmsLimitStall('+1BBB222', { attempts: 5, nextRetryAt: next, conversationKey: 'direct:+1BBB222:+1Y' });
    const list = await store.listSmsLimitStalls();
    const lines = list.map(s => s.lineNumber).sort();
    expect(lines).toContain('+1AAA111');
    expect(lines).toContain('+1BBB222');
    const b = list.find(s => s.lineNumber === '+1BBB222');
    expect(b?.attempts).toBe(5);
    expect(b?.conversationKey).toBe('direct:+1BBB222:+1Y');
  });

  it('snapshot reflects the live counter state', async () => {
    const now = new Date('2026-05-09T12:00:00.000Z');
    await store.recordOutbound({ lineNumber: LINE, phoneNumber: NUMBER, withinReplyWindow: true, now });
    await store.recordOutbound({ lineNumber: LINE, phoneNumber: NUMBER, withinReplyWindow: false, now });
    await store.recordInbound(LINE, NUMBER, now);
    await store.setSmsLimitStall(LINE, {
      attempts: 1,
      nextRetryAt: new Date(now.getTime() + 3600_000),
      conversationKey: `direct:${LINE}:${NUMBER}`
    });

    const snap = await store.snapshot(LINE, now);
    expect(snap.lineNumber).toBe(LINE);
    expect(snap.outbound.dayCount).toBe(2);
    expect(snap.outbound.hourCount).toBe(2);
    expect(snap.followUpsToday).toBe(1);
    expect(snap.inboundContactsToday).toBe(1);
    expect(snap.smsLimitStallAttempts).toBe(1);
    expect(typeof snap.smsLimitNextRetryAt).toBe('string');
  });

  it('outbound second-bucket counter expires within ~2s (key TTL)', async () => {
    const now = new Date();
    await store.recordOutbound({ lineNumber: LINE, phoneNumber: NUMBER, withinReplyWindow: true, now });
    const secondBucket = Math.floor(now.getTime() / 1000);
    const ttl = await redis.pttl(
      `sendblue-ai-agent:limits:outbound:second:${LINE}:${secondBucket}`
    );
    // INCR + EXPIRE 2 → TTL between ~1500 and 2000 ms.
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(2000);
  });

  it('bumpCounter atomically sets TTL on first INCR (Lua EVAL)', async () => {
    // Drive bumpCounter via recordOutbound, then re-bump and assert the TTL
    // is still set. The EVAL path collapses INCR + conditional EXPIRE into
    // one Redis-side script so eviction between calls cannot leave the key
    // immortal. We can't easily simulate eviction, but we can confirm:
    //   - First call (value === 1) sets TTL.
    //   - Second call (value === 2) does NOT clear / reset TTL.
    const now = new Date();
    await store.recordOutbound({ lineNumber: LINE, phoneNumber: NUMBER, withinReplyWindow: false, now });
    const dayKey = `${now.getUTCFullYear()}-${now.getUTCMonth() + 1}-${now.getUTCDate()}`;
    const fullKey = `sendblue-ai-agent:limits:outbound:day:${LINE}:${dayKey}`;
    const ttlAfterFirst = await redis.ttl(fullKey);
    expect(ttlAfterFirst).toBeGreaterThan(0);
    expect(ttlAfterFirst).toBeLessThanOrEqual(86400);

    await store.recordOutbound({ lineNumber: LINE, phoneNumber: NUMBER, withinReplyWindow: false, now });
    const value = await redis.get(fullKey);
    expect(value).toBe('2');
    // TTL should still be a finite positive value (not -1 = no TTL).
    const ttlAfterSecond = await redis.ttl(fullKey);
    expect(ttlAfterSecond).toBeGreaterThan(0);
  });
});
