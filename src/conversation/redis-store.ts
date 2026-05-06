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

  async close(): Promise<void> {
    this.redis.disconnect();
  }
}
