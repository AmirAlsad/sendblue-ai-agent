// Boot-time recovery for transient-retry and SMS-limit-stall timers.
//
// Skipped by default. Opt in with `TEST_REDIS_URL=redis://localhost:6379/15`
// (the same gate as `limits-redis-store.test.ts`). The tests directly
// persist conversation + stall state to Redis, call
// `agent.recoverPendingRetries()`, and verify the timers fire.

import pino from 'pino';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Redis } from 'ioredis';
import type { ChatClient } from '../../src/chat/client.js';
import type { ChatEndpointRequest, ChatEndpointResponse } from '../../src/chat/types.js';
import { createApp } from '../../src/http/app.js';
import { type SendblueClient } from '../../src/sendblue/client.js';
import type {
  SendblueActionResult,
  SendblueContactRequest,
  SendblueContactResult,
  SendblueMarkReadRequest,
  SendblueOutboundGroupMessage,
  SendblueOutboundMessage,
  SendblueReactionRequest,
  SendblueSendResult,
  SendblueTypingIndicator,
  SendblueTypingIndicatorResult
} from '../../src/sendblue/types.js';
import type { ConversationRecord } from '../../src/conversation/types.js';
import { directConversationKey } from '../../src/conversation/types.js';
import { testConfig } from '../helpers/config.js';

const TEST_REDIS_URL = process.env.TEST_REDIS_URL;
const describeOrSkip = TEST_REDIS_URL ? describe : describe.skip;

class QueueChatClient implements ChatClient {
  responses: Array<ChatEndpointResponse | Promise<ChatEndpointResponse>> = [];
  calls: ChatEndpointRequest[] = [];

  async complete(request: ChatEndpointRequest): Promise<ChatEndpointResponse> {
    this.calls.push(request);
    return this.responses.shift() ?? { messages: ['default reply'] };
  }
}

class FakeSendblueClient implements SendblueClient {
  calls: SendblueOutboundMessage[] = [];
  async sendMessage(message: SendblueOutboundMessage): Promise<SendblueSendResult> {
    this.calls.push(message);
    return { messageHandle: `recovered-${this.calls.length}`, raw: { ok: true } };
  }
  async sendGroupMessage(message: SendblueOutboundGroupMessage): Promise<SendblueSendResult> {
    return { messageHandle: `group-${message.groupId}`, raw: { ok: true } };
  }
  async sendReaction(reaction: SendblueReactionRequest): Promise<SendblueActionResult> {
    return { status: 'OK', messageHandle: reaction.messageHandle, raw: { ok: true } };
  }
  async markRead(receipt: SendblueMarkReadRequest): Promise<SendblueActionResult> {
    return { status: 'OK', number: receipt.toNumber, raw: { ok: true } };
  }
  async sendTypingIndicator(indicator: SendblueTypingIndicator): Promise<SendblueTypingIndicatorResult> {
    return { status: 'SENT', raw: { ok: true } };
  }
  async createContact(contact: SendblueContactRequest): Promise<SendblueContactResult> {
    return { number: contact.number, raw: { ok: true } };
  }
}

function persistedSendingRecord(args: {
  key: string;
  lineNumber: string;
  phoneNumber: string;
  itemId: string;
  retryCount: number;
  nextRetryAt: string;
  content?: string;
}): ConversationRecord {
  return {
    key: args.key,
    state: 'sending',
    type: 'direct',
    lineNumber: args.lineNumber,
    phoneNumber: args.phoneNumber,
    channel: 'imessage',
    smsDowngraded: false,
    inboundBuffer: [],
    lateArrivals: [],
    lastInboundMessageHandles: [],
    outboundQueue: [
      {
        id: args.itemId,
        kind: 'message',
        content: args.content ?? 'recovered text',
        retryCount: args.retryCount,
        nextRetryAt: args.nextRetryAt
      }
    ],
    deliveredMessages: [],
    cancelledMessages: [],
    currentOutboundIndex: 0,
    currentOutboundHandle: undefined,
    reprocessCount: 0,
    identity: null,
    typing: null,
    lastActivity: Date.now()
  };
}

describeOrSkip('recoverPendingRetries (live Redis)', () => {
  let redis: Redis;

  beforeAll(async () => {
    redis = new Redis(TEST_REDIS_URL!, { maxRetriesPerRequest: null });
    expect(await redis.ping()).toBe('PONG');
  });

  afterAll(async () => {
    await redis.quit();
  });

  beforeEach(async () => {
    await redis.flushdb();
  });

  afterEach(async () => {
    await redis.flushdb();
  });

  it('re-arms a transient-retry timer for a persisted conversation in sending state', async () => {
    const lineNumber = '+15552220000';
    const phoneNumber = '+15551110001';
    const key = directConversationKey(lineNumber, phoneNumber);
    // Real time — 75ms is short enough to keep the test fast and long
    // enough that the recovery's setTimeout fires under normal load.
    const remainingMs = 75;
    const record = persistedSendingRecord({
      key,
      lineNumber,
      phoneNumber,
      itemId: '123-0',
      retryCount: 1,
      nextRetryAt: new Date(Date.now() + remainingMs).toISOString()
    });
    await redis.set(`sendblue-ai-agent:conversation:${key}`, JSON.stringify(record), 'EX', 86400);

    const chatClient = new QueueChatClient();
    const sendblueClient = new FakeSendblueClient();
    const config = testConfig({
      redisUrl: TEST_REDIS_URL!,
      transientRetryBaseMs: 100,
      transientRetryMaxMs: 200,
      sendblueFromNumber: lineNumber
    });
    const app = createApp({
      config,
      chatClient,
      sendblueClient,
      logger: pino({ level: 'silent' })
    });

    const recovered = await app.conversationAgent.recoverPendingRetries();
    expect(recovered.transientRetriesResumed).toBe(1);

    // Wait long enough for the recovered setTimeout to fire AND for the
    // resulting `runRetry → sendCurrentMessage → sendMessage` chain to
    // complete (Redis getConversation + ioredis is fast on localhost).
    await new Promise<void>(resolve => setTimeout(resolve, remainingMs + 200));

    expect(sendblueClient.calls.length).toBe(1);
    expect(sendblueClient.calls[0].content).toBe('recovered text');

    await app.close();
  });

  it('drops a stranded SMS-limit stall whose conversation is no longer in sending state', async () => {
    const lineNumber = '+15552220099';
    const phoneNumber = '+15551110099';
    const key = directConversationKey(lineNumber, phoneNumber);
    const now = new Date('2026-05-09T12:00:00.000Z');
    vi.setSystemTime(now);

    // Persist a stall but no conversation record — the stall is stranded.
    await redis.set(
      `sendblue-ai-agent:limits:sms-stall:${lineNumber}`,
      JSON.stringify({
        attempts: 2,
        nextRetryAt: new Date(now.getTime() + 1000).toISOString(),
        conversationKey: key
      }),
      'EX',
      24 * 3600
    );

    const config = testConfig({ redisUrl: TEST_REDIS_URL!, sendblueFromNumber: lineNumber });
    const app = createApp({
      config,
      chatClient: new QueueChatClient(),
      sendblueClient: new FakeSendblueClient(),
      logger: pino({ level: 'silent' })
    });

    const recovered = await app.conversationAgent.recoverPendingRetries();
    expect(recovered.smsStallsResumed).toBe(0);

    // The stranded stall was cleared.
    const value = await redis.get(`sendblue-ai-agent:limits:sms-stall:${lineNumber}`);
    expect(value).toBeNull();

    await app.close();
  });

  it('returns 0/0 with an in-memory store (no recovery possible)', async () => {
    const config = testConfig({ redisUrl: undefined });
    const app = createApp({
      config,
      chatClient: new QueueChatClient(),
      sendblueClient: new FakeSendblueClient(),
      logger: pino({ level: 'silent' })
    });
    const recovered = await app.conversationAgent.recoverPendingRetries();
    expect(recovered).toEqual({ smsStallsResumed: 0, transientRetriesResumed: 0 });
    await app.close();
  });
});
