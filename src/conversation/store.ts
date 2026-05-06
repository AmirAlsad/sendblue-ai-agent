import type { AgentConfig } from '../config/env.js';
import type { ConversationRecord, OutboundHandleMapping } from './types.js';

export type ConversationStore = {
  getConversation(key: string): Promise<ConversationRecord | undefined>;
  setConversation(record: ConversationRecord): Promise<void>;
  deleteConversation(key: string): Promise<void>;
  claimInboundHandle(messageHandle: string): Promise<boolean>;
  mapOutboundHandle(messageHandle: string, mapping: OutboundHandleMapping): Promise<void>;
  getOutboundHandleMapping(messageHandle: string): Promise<OutboundHandleMapping | undefined>;
  deleteOutboundHandleMapping(messageHandle: string): Promise<void>;
  close?(): Promise<void>;
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class InMemoryConversationStore implements ConversationStore {
  private readonly conversations = new Map<string, ConversationRecord>();
  private readonly inboundHandles = new Map<string, number>();
  private readonly outboundHandles = new Map<string, OutboundHandleMapping>();

  constructor(private readonly config: Pick<AgentConfig, 'dedupeTtlSeconds'>) {}

  async getConversation(key: string): Promise<ConversationRecord | undefined> {
    const record = this.conversations.get(key);
    return record ? clone(record) : undefined;
  }

  async setConversation(record: ConversationRecord): Promise<void> {
    this.conversations.set(record.key, clone(record));
  }

  async deleteConversation(key: string): Promise<void> {
    this.conversations.delete(key);
  }

  async claimInboundHandle(messageHandle: string): Promise<boolean> {
    const now = Date.now();
    const expiresAt = this.inboundHandles.get(messageHandle);
    if (expiresAt && expiresAt > now) return false;

    this.inboundHandles.set(messageHandle, now + this.config.dedupeTtlSeconds * 1000);
    return true;
  }

  async mapOutboundHandle(messageHandle: string, mapping: OutboundHandleMapping): Promise<void> {
    this.outboundHandles.set(messageHandle, clone(mapping));
  }

  async getOutboundHandleMapping(messageHandle: string): Promise<OutboundHandleMapping | undefined> {
    const mapping = this.outboundHandles.get(messageHandle);
    return mapping ? clone(mapping) : undefined;
  }

  async deleteOutboundHandleMapping(messageHandle: string): Promise<void> {
    this.outboundHandles.delete(messageHandle);
  }
}
