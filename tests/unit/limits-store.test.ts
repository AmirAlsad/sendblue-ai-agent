import { describe, expect, it } from 'vitest';
import { InMemoryLimitCounterStore } from '../../src/limits/store.js';

const LINE = '+15552220000';
const NUMBER = '+15551110001';

function at(iso: string): Date {
  return new Date(iso);
}

describe('InMemoryLimitCounterStore', () => {
  it('returns 0 delay for the first acquireOutboundSlot and paces subsequent ones at 1/s', async () => {
    const store = new InMemoryLimitCounterStore();
    const t0 = at('2026-05-08T00:00:00.000Z');
    const first = await store.acquireOutboundSlot(LINE, t0, 1);
    expect(first.delayMs).toBe(0);

    const t1 = at('2026-05-08T00:00:00.500Z');
    const second = await store.acquireOutboundSlot(LINE, t1, 1);
    expect(second.delayMs).toBe(500);

    const t2 = at('2026-05-08T00:00:02.000Z');
    const third = await store.acquireOutboundSlot(LINE, t2, 1);
    expect(third.delayMs).toBe(0);
  });

  it('does not accumulate burst credits during long idle gaps', async () => {
    const store = new InMemoryLimitCounterStore();
    await store.acquireOutboundSlot(LINE, at('2026-05-08T00:00:00.000Z'), 1);
    // 60s pause then two sends back-to-back; the second must pace.
    const r1 = await store.acquireOutboundSlot(LINE, at('2026-05-08T00:01:00.000Z'), 1);
    const r2 = await store.acquireOutboundSlot(LINE, at('2026-05-08T00:01:00.100Z'), 1);
    expect(r1.delayMs).toBe(0);
    expect(r2.delayMs).toBeGreaterThan(0);
  });

  it('treats perSecond <= 0 as no pacing', async () => {
    const store = new InMemoryLimitCounterStore();
    const r = await store.acquireOutboundSlot(LINE, at('2026-05-08T00:00:00.000Z'), 0);
    expect(r.delayMs).toBe(0);
  });

  it('counts distinct inbound numbers per line per UTC day', async () => {
    const store = new InMemoryLimitCounterStore();
    const day1 = at('2026-05-08T00:00:00.000Z');
    const r1 = await store.recordInbound(LINE, NUMBER, day1);
    expect(r1).toEqual({ distinctToday: 1, firstSeenToday: true });

    const r2 = await store.recordInbound(LINE, NUMBER, day1);
    expect(r2).toEqual({ distinctToday: 1, firstSeenToday: false });

    const r3 = await store.recordInbound(LINE, '+15551110002', day1);
    expect(r3).toEqual({ distinctToday: 2, firstSeenToday: true });
  });

  it('rolls over the distinct-inbound set on a new UTC day', async () => {
    const store = new InMemoryLimitCounterStore();
    await store.recordInbound(LINE, NUMBER, at('2026-05-08T23:59:00.000Z'));
    const next = await store.recordInbound(LINE, NUMBER, at('2026-05-10T00:00:01.000Z'));
    expect(next).toEqual({ distinctToday: 1, firstSeenToday: true });
  });

  it('classifies follow-up vs in-window outbound', async () => {
    const store = new InMemoryLimitCounterStore();
    const now = at('2026-05-08T00:00:00.000Z');

    const inWindow = await store.recordOutbound({
      lineNumber: LINE,
      phoneNumber: NUMBER,
      withinReplyWindow: true,
      now
    });
    expect(inWindow.followUpsToday).toBe(0);

    const followUp = await store.recordOutbound({
      lineNumber: LINE,
      phoneNumber: NUMBER,
      withinReplyWindow: false,
      now
    });
    expect(followUp.followUpsToday).toBe(1);
  });

  it('persists and reads last_inbound_at per (line, number)', async () => {
    const store = new InMemoryLimitCounterStore();
    const now = at('2026-05-08T00:00:00.000Z');
    await store.setLastInboundAt(LINE, NUMBER, now);
    const got = await store.getLastInboundAt(LINE, NUMBER);
    expect(got?.toISOString()).toBe(now.toISOString());

    const missing = await store.getLastInboundAt(LINE, '+15551110099');
    expect(missing).toBeUndefined();
  });

  it('manages SMS_LIMIT_REACHED stall metadata with conversationKey', async () => {
    const store = new InMemoryLimitCounterStore();
    const next = at('2026-05-08T01:00:00.000Z');
    const conversationKey = `direct:${LINE}:${NUMBER}`;
    await store.setSmsLimitStall(LINE, { attempts: 2, nextRetryAt: next, conversationKey });
    const got = await store.getSmsLimitStall(LINE);
    expect(got?.attempts).toBe(2);
    expect(got?.nextRetryAt.toISOString()).toBe(next.toISOString());
    expect(got?.conversationKey).toBe(conversationKey);

    await store.clearSmsLimitStall(LINE);
    expect(await store.getSmsLimitStall(LINE)).toBeUndefined();
  });

  it('listSmsLimitStalls returns every active stall', async () => {
    const store = new InMemoryLimitCounterStore();
    const next = at('2026-05-08T01:00:00.000Z');
    await store.setSmsLimitStall('+1A', { attempts: 1, nextRetryAt: next, conversationKey: 'direct:+1A:+1X' });
    await store.setSmsLimitStall('+1B', { attempts: 3, nextRetryAt: next, conversationKey: 'direct:+1B:+1Y' });
    const list = await store.listSmsLimitStalls();
    expect(list).toHaveLength(2);
    expect(list.map(s => s.lineNumber).sort()).toEqual(['+1A', '+1B']);
    expect(list.find(s => s.lineNumber === '+1B')?.conversationKey).toBe('direct:+1B:+1Y');
  });

  it('exposes a snapshot covering second/hour/day/inbound/follow-ups/sms-stall', async () => {
    const store = new InMemoryLimitCounterStore();
    const now = at('2026-05-08T00:00:00.000Z');
    await store.recordOutbound({ lineNumber: LINE, phoneNumber: NUMBER, withinReplyWindow: false, now });
    await store.recordOutbound({ lineNumber: LINE, phoneNumber: NUMBER, withinReplyWindow: true, now });
    await store.recordInbound(LINE, NUMBER, now);

    const snap = await store.snapshot(LINE, now);
    expect(snap.outbound.dayCount).toBe(2);
    expect(snap.outbound.hourCount).toBe(2);
    expect(snap.outbound.secondCount).toBe(2);
    expect(snap.followUpsToday).toBe(1);
    expect(snap.inboundContactsToday).toBe(1);
    expect(snap.smsLimitStallAttempts).toBe(0);
  });
});
