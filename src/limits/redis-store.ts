import { Redis } from 'ioredis';
import type { AgentConfig } from '../config/env.js';
import type {
  AcquireOutboundSlotResult,
  LimitCounterStore,
  LimitSnapshot,
  RecordInboundResult,
  RecordOutboundResult,
  SmsLimitStall,
  SmsLimitStallEntry
} from './store.js';

/**
 * Redis-backed `LimitCounterStore` used in production.
 *
 * Time-window counters (`hour:`, `day:`, `second:`) use `INCR` + `EXPIRE` for
 * O(1) increments and automatic expiry. Distinct inbound contacts use a
 * `SADD`/`SCARD` set per (line, day) with TTL 1 day. The token-bucket
 * pacing gate is implemented as a Lua `EVAL` for atomic compare-and-set;
 * this is what makes multi-replica pacing actually respect 1/s on the line
 * (the in-memory store overshoots when there are multiple replicas).
 *
 * Key prefix `sendblue-ai-agent:limits:*` is shared across all keys so the
 * namespace can be flushed on a redeploy without clobbering conversation
 * state (`sendblue-ai-agent:conversation:*`) or dedupe (`...:dedupe:*`).
 */
const KEY_PREFIX = 'sendblue-ai-agent:limits';

const ACQUIRE_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local interval = tonumber(ARGV[2])
local last = tonumber(redis.call('GET', key) or '0')
local nextAvailable = last + interval
local slot = nextAvailable
if now > nextAvailable then slot = now end
local ttl = interval * 4
if ttl < 1000 then ttl = 1000 end
redis.call('SET', key, slot, 'PX', ttl)
local delay = slot - now
if delay < 0 then delay = 0 end
return delay
`.trim();

// Atomic INCR + EXPIRE-on-first. The standalone two-call sequence has a
// failure mode under Redis eviction: if the key is evicted between INCR
// (which would recreate it without a TTL) and EXPIRE, the counter becomes
// immortal. EVAL is atomic Redis-side, so the EXPIRE always lands when
// INCR returns 1. ARGV[1] is the TTL in seconds.
const BUMP_COUNTER_LUA = `
local v = redis.call('INCR', KEYS[1])
if v == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return v
`.trim();

function utcDayKey(date: Date): string {
  return `${date.getUTCFullYear()}-${date.getUTCMonth() + 1}-${date.getUTCDate()}`;
}

function utcHourKey(date: Date): string {
  return `${utcDayKey(date)}-${date.getUTCHours()}`;
}

export class RedisLimitCounterStore implements LimitCounterStore {
  private readonly redis: Redis;

  constructor(config: AgentConfig, redis?: Redis) {
    if (!redis && !config.redisUrl) {
      throw new Error('RedisLimitCounterStore requires REDIS_URL when no redis instance is provided');
    }
    this.redis = redis ?? new Redis(config.redisUrl!, { maxRetriesPerRequest: null });
  }

  async acquireOutboundSlot(
    lineNumber: string,
    now: Date,
    perSecond: number
  ): Promise<AcquireOutboundSlotResult> {
    if (perSecond <= 0) return { delayMs: 0 };
    const intervalMs = Math.max(1, Math.floor(1000 / perSecond));
    const result = (await this.redis.eval(
      ACQUIRE_LUA,
      1,
      `${KEY_PREFIX}:slot:${lineNumber}`,
      String(now.getTime()),
      String(intervalMs)
    )) as number;
    return { delayMs: typeof result === 'number' ? Math.max(0, result) : 0 };
  }

  async recordOutbound(args: {
    lineNumber: string;
    phoneNumber: string;
    withinReplyWindow: boolean;
    now: Date;
  }): Promise<RecordOutboundResult> {
    const dayKey = utcDayKey(args.now);
    const hourKey = utcHourKey(args.now);
    const secondBucket = Math.floor(args.now.getTime() / 1000);

    const dayCount = await this.bumpCounter(`outbound:day:${args.lineNumber}:${dayKey}`, 86400);
    const hourCount = await this.bumpCounter(`outbound:hour:${args.lineNumber}:${hourKey}`, 3600);
    const secondCount = await this.bumpCounter(`outbound:second:${args.lineNumber}:${secondBucket}`, 2);

    let followUpsToday = 0;
    if (args.withinReplyWindow) {
      const raw = await this.redis.get(`${KEY_PREFIX}:followup:day:${args.lineNumber}:${dayKey}`);
      followUpsToday = raw ? Number.parseInt(raw, 10) || 0 : 0;
    } else {
      followUpsToday = await this.bumpCounter(`followup:day:${args.lineNumber}:${dayKey}`, 86400);
    }

    return { secondCount, hourCount, dayCount, followUpsToday };
  }

  async recordInbound(
    lineNumber: string,
    phoneNumber: string,
    now: Date
  ): Promise<RecordInboundResult> {
    const setKey = `${KEY_PREFIX}:inbound:distinct:${lineNumber}:${utcDayKey(now)}`;
    const added = await this.redis.sadd(setKey, phoneNumber);
    await this.redis.expire(setKey, 86400);
    const distinctToday = await this.redis.scard(setKey);
    return { distinctToday, firstSeenToday: added === 1 };
  }

  async setLastInboundAt(lineNumber: string, phoneNumber: string, when: Date): Promise<void> {
    await this.redis.set(
      `${KEY_PREFIX}:last-inbound:${lineNumber}:${phoneNumber}`,
      when.toISOString(),
      'EX',
      86400
    );
  }

  async getLastInboundAt(lineNumber: string, phoneNumber: string): Promise<Date | undefined> {
    const raw = await this.redis.get(`${KEY_PREFIX}:last-inbound:${lineNumber}:${phoneNumber}`);
    if (!raw) return undefined;
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }

  async getSmsLimitStall(lineNumber: string): Promise<SmsLimitStall | undefined> {
    const raw = await this.redis.get(`${KEY_PREFIX}:sms-stall:${lineNumber}`);
    if (!raw) return undefined;
    return parseSmsLimitStall(raw);
  }

  async setSmsLimitStall(lineNumber: string, stall: SmsLimitStall): Promise<void> {
    await this.redis.set(
      `${KEY_PREFIX}:sms-stall:${lineNumber}`,
      JSON.stringify({
        attempts: stall.attempts,
        nextRetryAt: stall.nextRetryAt.toISOString(),
        conversationKey: stall.conversationKey
      }),
      'EX',
      24 * 3600
    );
  }

  async clearSmsLimitStall(lineNumber: string): Promise<void> {
    await this.redis.del(`${KEY_PREFIX}:sms-stall:${lineNumber}`);
  }

  async listSmsLimitStalls(): Promise<SmsLimitStallEntry[]> {
    // Use SCAN to enumerate stall keys; the keyspace is bounded by the
    // number of Sendblue lines (small), so SCAN cost is O(lines).
    const matchPattern = `${KEY_PREFIX}:sms-stall:*`;
    const stalls: SmsLimitStallEntry[] = [];
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', matchPattern, 'COUNT', 100);
      cursor = next;
      if (keys.length === 0) continue;
      const values = await this.redis.mget(...keys);
      for (let i = 0; i < keys.length; i += 1) {
        const raw = values[i];
        if (!raw) continue;
        const parsed = parseSmsLimitStall(raw);
        if (!parsed) continue;
        const lineNumber = keys[i].slice(`${KEY_PREFIX}:sms-stall:`.length);
        stalls.push({ lineNumber, ...parsed });
      }
    } while (cursor !== '0');
    return stalls;
  }

  async snapshot(lineNumber: string, now: Date): Promise<LimitSnapshot> {
    const dayKey = utcDayKey(now);
    const hourKey = utcHourKey(now);
    const secondBucket = Math.floor(now.getTime() / 1000);
    const [dayRaw, hourRaw, secondRaw, distinctToday, followUpsRaw, stall] = await Promise.all([
      this.redis.get(`${KEY_PREFIX}:outbound:day:${lineNumber}:${dayKey}`),
      this.redis.get(`${KEY_PREFIX}:outbound:hour:${lineNumber}:${hourKey}`),
      this.redis.get(`${KEY_PREFIX}:outbound:second:${lineNumber}:${secondBucket}`),
      this.redis.scard(`${KEY_PREFIX}:inbound:distinct:${lineNumber}:${dayKey}`),
      this.redis.get(`${KEY_PREFIX}:followup:day:${lineNumber}:${dayKey}`),
      this.getSmsLimitStall(lineNumber)
    ]);
    return {
      lineNumber,
      outbound: {
        dayCount: parseCount(dayRaw),
        hourCount: parseCount(hourRaw),
        secondCount: parseCount(secondRaw)
      },
      inboundContactsToday: distinctToday,
      followUpsToday: parseCount(followUpsRaw),
      smsLimitStallAttempts: stall?.attempts ?? 0,
      smsLimitNextRetryAt: stall?.nextRetryAt.toISOString()
    };
  }

  async close(): Promise<void> {
    this.redis.disconnect();
  }

  private async bumpCounter(suffix: string, ttlSeconds: number): Promise<number> {
    const key = `${KEY_PREFIX}:${suffix}`;
    const result = (await this.redis.eval(BUMP_COUNTER_LUA, 1, key, String(ttlSeconds))) as number;
    return typeof result === 'number' ? result : 0;
  }
}

function parseCount(raw: string | null): number {
  if (!raw) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseSmsLimitStall(raw: string): SmsLimitStall | undefined {
  try {
    const parsed = JSON.parse(raw) as {
      attempts?: number;
      nextRetryAt?: string;
      conversationKey?: string;
    };
    if (typeof parsed.attempts !== 'number' || !parsed.nextRetryAt) return undefined;
    const date = new Date(parsed.nextRetryAt);
    if (Number.isNaN(date.getTime())) return undefined;
    // `conversationKey` is required by the new shape; legacy entries written
    // before this field existed are treated as expired (the boot-time
    // recovery has no conversation to resume against).
    if (typeof parsed.conversationKey !== 'string' || !parsed.conversationKey) return undefined;
    return { attempts: parsed.attempts, nextRetryAt: date, conversationKey: parsed.conversationKey };
  } catch {
    return undefined;
  }
}
