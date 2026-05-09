import { Redis } from 'ioredis';
import type { AgentConfig } from '../config/env.js';
import type { ConversationRecord, OutboundHandleMapping } from './types.js';
import type { ConversationStore } from './store.js';

function conversationKey(key: string): string {
  return `sendblue-ai-agent:conversation:${key}`;
}

function inboundDedupeKey(messageHandle: string): string {
  return `sendblue-ai-agent:dedupe:inbound:${messageHandle}`;
}

function outboundMappingKey(messageHandle: string): string {
  return `sendblue-ai-agent:outbound:${messageHandle}`;
}

function contactUpsertKey(lineNumber: string, phoneNumber: string): string {
  return `sendblue-ai-agent:contact-upserted:${lineNumber}:${phoneNumber}`;
}

export class RedisConversationStore implements ConversationStore {
  private readonly redis: Redis;

  constructor(private readonly config: AgentConfig, redis?: Redis) {
    this.redis = redis ?? new Redis(config.redisUrl!, { maxRetriesPerRequest: null });
  }

  async getConversation(key: string): Promise<ConversationRecord | undefined> {
    const raw = await this.redis.get(conversationKey(key));
    return raw ? (JSON.parse(raw) as ConversationRecord) : undefined;
  }

  async setConversation(record: ConversationRecord): Promise<void> {
    await this.redis.set(
      conversationKey(record.key),
      JSON.stringify(record),
      'EX',
      this.config.conversationTtlSeconds
    );
  }

  async deleteConversation(key: string): Promise<void> {
    await this.redis.del(conversationKey(key));
  }

  async claimInboundHandle(messageHandle: string): Promise<boolean> {
    const result = await this.redis.set(
      inboundDedupeKey(messageHandle),
      '1',
      'EX',
      this.config.dedupeTtlSeconds,
      'NX'
    );
    return result === 'OK';
  }

  async peekInboundHandle(messageHandle: string): Promise<{ present: boolean; ttlSeconds?: number }> {
    const key = inboundDedupeKey(messageHandle);
    // ioredis returns -2 when the key does not exist, -1 when present without
    // TTL. Issue TTL alone (skip EXISTS) so the EXISTS→TTL TOCTOU window
    // cannot report `{ present: true, ttl: undefined }` for a key that
    // expired between the two commands.
    const ttl = await this.redis.ttl(key);
    if (ttl === -2) return { present: false };
    return { present: true, ttlSeconds: ttl >= 0 ? ttl : undefined };
  }

  async mapOutboundHandle(messageHandle: string, mapping: OutboundHandleMapping): Promise<void> {
    await this.redis.set(
      outboundMappingKey(messageHandle),
      JSON.stringify(mapping),
      'EX',
      this.config.conversationTtlSeconds
    );
  }

  async getOutboundHandleMapping(messageHandle: string): Promise<OutboundHandleMapping | undefined> {
    const raw = await this.redis.get(outboundMappingKey(messageHandle));
    return raw ? (JSON.parse(raw) as OutboundHandleMapping) : undefined;
  }

  async deleteOutboundHandleMapping(messageHandle: string): Promise<void> {
    await this.redis.del(outboundMappingKey(messageHandle));
  }

  async claimContactUpsert(lineNumber: string, phoneNumber: string, ttlSeconds: number): Promise<boolean> {
    // Defensive guard: Redis rejects `EX 0` with "ERR invalid expire time".
    // Treat any non-positive TTL as "claim failed" so the caller skips the
    // upsert rather than crashing the inbound webhook handler. The config
    // loader enforces `>= 1` for `SENDBLUE_CONTACTS_DEDUPE_TTL_SECONDS`,
    // so this is belt-and-suspenders for direct callers.
    if (ttlSeconds <= 0) return false;
    const result = await this.redis.set(
      contactUpsertKey(lineNumber, phoneNumber),
      '1',
      'EX',
      ttlSeconds,
      'NX'
    );
    return result === 'OK';
  }

  async *listConversationKeys(): AsyncIterable<string> {
    const matchPattern = 'sendblue-ai-agent:conversation:*';
    const prefixLen = 'sendblue-ai-agent:conversation:'.length;
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', matchPattern, 'COUNT', 200);
      cursor = next;
      for (const key of keys) yield key.slice(prefixLen);
    } while (cursor !== '0');
  }

  async close(): Promise<void> {
    this.redis.disconnect();
  }
}
