import type { AgentConfig } from '../config/env.js';
import type { ConversationRecord, OutboundHandleMapping } from './types.js';

export type ConversationStore = {
  getConversation(key: string): Promise<ConversationRecord | undefined>;
  setConversation(record: ConversationRecord): Promise<void>;
  deleteConversation(key: string): Promise<void>;
  claimInboundHandle(messageHandle: string): Promise<boolean>;
  /**
   * Non-destructive peek of the inbound dedupe set. Used by `/admin/dedupe`
   * to check whether a handle is currently marked claimed without claiming it.
   * Returns `present: true` when the handle is in the set within the TTL.
   */
  peekInboundHandle(messageHandle: string): Promise<{ present: boolean; ttlSeconds?: number }>;
  mapOutboundHandle(messageHandle: string, mapping: OutboundHandleMapping): Promise<void>;
  getOutboundHandleMapping(messageHandle: string): Promise<OutboundHandleMapping | undefined>;
  deleteOutboundHandleMapping(messageHandle: string): Promise<void>;
  /**
   * SETNX-with-TTL claim used to dedupe Sendblue contact upserts. Returns
   * true the first time we see a `(lineNumber, phoneNumber)` pair within
   * the TTL window (caller should upsert), false otherwise (skip).
   */
  claimContactUpsert(lineNumber: string, phoneNumber: string, ttlSeconds: number): Promise<boolean>;
  /**
   * Enumerate every stored conversation key. Used by `recoverPendingRetries`
   * at boot to find conversations with `state === 'sending'` and a queued
   * item carrying `nextRetryAt` so we can re-arm transient-retry timers.
   * The Redis impl uses SCAN; the in-memory impl iterates the Map.
   */
  listConversationKeys(): AsyncIterable<string>;
  close?(): Promise<void>;
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class InMemoryConversationStore implements ConversationStore {
  private readonly conversations = new Map<string, ConversationRecord>();
  private readonly inboundHandles = new Map<string, number>();
  private readonly outboundHandles = new Map<string, OutboundHandleMapping>();
  private readonly contactUpserts = new Map<string, number>();

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

  async peekInboundHandle(messageHandle: string): Promise<{ present: boolean; ttlSeconds?: number }> {
    const now = Date.now();
    const expiresAt = this.inboundHandles.get(messageHandle);
    if (!expiresAt || expiresAt <= now) return { present: false };
    return { present: true, ttlSeconds: Math.max(0, Math.floor((expiresAt - now) / 1000)) };
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

  async claimContactUpsert(lineNumber: string, phoneNumber: string, ttlSeconds: number): Promise<boolean> {
    if (ttlSeconds <= 0) return false;
    const key = `${lineNumber}:${phoneNumber}`;
    const now = Date.now();
    const expiresAt = this.contactUpserts.get(key);
    if (expiresAt && expiresAt > now) return false;
    this.contactUpserts.set(key, now + ttlSeconds * 1000);
    return true;
  }

  async *listConversationKeys(): AsyncIterable<string> {
    for (const key of this.conversations.keys()) yield key;
  }
}
