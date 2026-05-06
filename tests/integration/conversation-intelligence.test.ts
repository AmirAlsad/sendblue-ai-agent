import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatClient } from '../../src/chat/client.js';
import type { ChatEndpointRequest, ChatEndpointResponse } from '../../src/chat/types.js';
import { createApp } from '../../src/http/app.js';
import type { IdentityResolver } from '../../src/identity/resolver.js';
import type { SendblueClient } from '../../src/sendblue/client.js';
import type {
  SendblueActionResult,
  SendblueMarkReadRequest,
  SendblueOutboundGroupMessage,
  SendblueOutboundMessage,
  SendblueReactionRequest,
  SendblueSendResult,
  SendblueTypingIndicator,
  SendblueTypingIndicatorResult
} from '../../src/sendblue/types.js';
import { dispatch } from '../helpers/dispatch.js';
import { loadFixture } from '../helpers/fixtures.js';
import { testConfig } from '../helpers/config.js';

class QueueChatClient implements ChatClient {
  calls: ChatEndpointRequest[] = [];
  responses: Array<ChatEndpointResponse | Promise<ChatEndpointResponse>> = [];

  async complete(request: ChatEndpointRequest): Promise<ChatEndpointResponse> {
    this.calls.push(request);
    return this.responses.shift() ?? { messages: ['default reply'] };
  }
}

class FakeSendblueClient implements SendblueClient {
  calls: SendblueOutboundMessage[] = [];
  groupCalls: SendblueOutboundGroupMessage[] = [];
  reactionCalls: SendblueReactionRequest[] = [];
  readCalls: SendblueMarkReadRequest[] = [];
  typingCalls: SendblueTypingIndicator[] = [];

  async sendMessage(message: SendblueOutboundMessage): Promise<SendblueSendResult> {
    this.calls.push(message);
    return { messageHandle: `sent-${this.calls.length}`, raw: { ok: true } };
  }

  async sendGroupMessage(message: SendblueOutboundGroupMessage): Promise<SendblueSendResult> {
    this.groupCalls.push(message);
    return { messageHandle: `group-${message.groupId}`, raw: { ok: true } };
  }

  async sendReaction(reaction: SendblueReactionRequest): Promise<SendblueActionResult> {
    this.reactionCalls.push(reaction);
    return { status: 'OK', reaction: reaction.reaction, raw: { ok: true } };
  }

  async markRead(receipt: SendblueMarkReadRequest): Promise<SendblueActionResult> {
    this.readCalls.push(receipt);
    return { status: 'OK', number: receipt.toNumber, raw: { ok: true } };
  }

  async sendTypingIndicator(indicator: SendblueTypingIndicator): Promise<SendblueTypingIndicatorResult> {
    this.typingCalls.push(indicator);
    return { status: 'SENT', raw: { ok: true } };
  }
}

function receivePayload(overrides: Record<string, unknown> = {}) {
  return {
    ...loadFixture<Record<string, unknown>>('sendblue/receive-basic.json'),
    ...overrides
  };
}

describe('conversation intelligence', () => {
  const config = testConfig({
    bufferBaseTimeoutMs: 25,
    bufferMaxTimeoutMs: 25,
    bufferNoiseMaxDeviation: 0,
    outboundDeliveryTimeoutMs: 5000
  });
  let chatClient: QueueChatClient;
  let sendblueClient: FakeSendblueClient;
  let close: () => Promise<void>;
  let app: ReturnType<typeof createApp>['app'];

  beforeEach(() => {
    vi.useFakeTimers();
    chatClient = new QueueChatClient();
    sendblueClient = new FakeSendblueClient();
    const created = createApp({
      config,
      chatClient,
      sendblueClient,
      logger: pino({ level: 'silent' })
    });
    app = created.app;
    close = created.close;
  });

  afterEach(async () => {
    await close();
    vi.useRealTimers();
  });

  it('buffers rapid inbound bursts into one chat request', async () => {
    chatClient.responses.push({ messages: ['combined reply'] });

    await dispatch(app, {
      method: 'POST',
      path: '/webhook/receive',
      headers: { [config.sendblueWebhookSecretHeader]: config.sendblueWebhookSecret! },
      body: receivePayload({ message_handle: 'burst-1', content: 'first' })
    });
    await dispatch(app, {
      method: 'POST',
      path: '/webhook/receive',
      headers: { [config.sendblueWebhookSecretHeader]: config.sendblueWebhookSecret! },
      body: receivePayload({ message_handle: 'burst-2', content: 'second' })
    });

    expect(chatClient.calls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(25);

    expect(chatClient.calls).toHaveLength(1);
    expect(chatClient.calls[0]).toMatchObject({
      message: 'first\n---\nsecond',
      messages: [
        { content: 'first', messageHandle: 'burst-1' },
        { content: 'second', messageHandle: 'burst-2' }
      ]
    });
    expect(sendblueClient.calls).toHaveLength(1);
  });

  it('reprocesses late arrivals that land while the chat endpoint is running', async () => {
    let resolveChat!: (response: ChatEndpointResponse) => void;
    chatClient.responses.push(new Promise(resolve => (resolveChat = resolve)));
    chatClient.responses.push({ messages: ['late reply'] });

    await dispatch(app, {
      method: 'POST',
      path: '/webhook/receive',
      headers: { [config.sendblueWebhookSecretHeader]: config.sendblueWebhookSecret! },
      body: receivePayload({ message_handle: 'late-1', content: 'first' })
    });

    await vi.advanceTimersByTimeAsync(25);
    expect(chatClient.calls).toHaveLength(1);

    await dispatch(app, {
      method: 'POST',
      path: '/webhook/receive',
      headers: { [config.sendblueWebhookSecretHeader]: config.sendblueWebhookSecret! },
      body: receivePayload({ message_handle: 'late-2', content: 'late' })
    });

    resolveChat({ messages: ['stale reply'] });
    await vi.advanceTimersByTimeAsync(25);

    expect(chatClient.calls).toHaveLength(2);
    expect(chatClient.calls[1].message).toBe('first\n---\nlate');
    expect(sendblueClient.calls[0].content).toBe('late reply');
  });

  it('uses SENT as the ordered-delivery gate for SMS conversations', async () => {
    chatClient.responses.push({ messages: ['one', 'two'] });

    await dispatch(app, {
      method: 'POST',
      path: '/webhook/receive',
      headers: { [config.sendblueWebhookSecretHeader]: config.sendblueWebhookSecret! },
      body: receivePayload({
        message_handle: 'sms-1',
        content: 'sms hello',
        service: 'SMS',
        was_downgraded: true
      })
    });
    await vi.advanceTimersByTimeAsync(25);

    expect(sendblueClient.calls.map(call => call.content)).toEqual(['one']);

    await dispatch(app, {
      method: 'POST',
      path: '/webhook/status',
      headers: { [config.sendblueWebhookSecretHeader]: config.sendblueWebhookSecret! },
      body: { message_handle: 'sent-1', status: 'SENT', service: 'SMS', was_downgraded: true }
    });

    expect(sendblueClient.calls.map(call => call.content)).toEqual(['one', 'two']);
    expect(sendblueClient.typingCalls).toHaveLength(0);
  });

  it('includes inbound typing state in the next chat request without calling chat for typing alone', async () => {
    chatClient.responses.push({ silence: true });

    await dispatch(app, {
      method: 'POST',
      path: '/webhook/typing-indicator',
      headers: { [config.sendblueWebhookSecretHeader]: config.sendblueWebhookSecret! },
      body: {
        number: '+15551110001',
        from_number: '+15552220000',
        is_typing: true,
        timestamp: '2026-05-06T12:00:00.000Z'
      }
    });

    expect(chatClient.calls).toHaveLength(0);

    await dispatch(app, {
      method: 'POST',
      path: '/webhook/receive',
      headers: { [config.sendblueWebhookSecretHeader]: config.sendblueWebhookSecret! },
      body: receivePayload({ message_handle: 'typing-next' })
    });
    await vi.advanceTimersByTimeAsync(25);

    expect(chatClient.calls[0].typing).toMatchObject({
      isTyping: true,
      timestamp: '2026-05-06T12:00:00.000Z'
    });
  });

  it('enriches chat requests with optional resolver identity and fails open', async () => {
    const resolver: IdentityResolver = {
      resolveByPhone: vi
        .fn()
        .mockResolvedValueOnce({ userId: 'user-123', data: { plan: 'pro' } })
        .mockRejectedValueOnce(new Error('resolver down'))
    };
    await close();
    const created = createApp({
      config,
      chatClient,
      sendblueClient,
      identityResolver: resolver,
      logger: pino({ level: 'silent' })
    });
    app = created.app;
    close = created.close;
    chatClient.responses.push({ silence: true }, { silence: true });

    await dispatch(app, {
      method: 'POST',
      path: '/webhook/receive',
      headers: { [config.sendblueWebhookSecretHeader]: config.sendblueWebhookSecret! },
      body: receivePayload({ message_handle: 'identity-1', from_number: '+15551110001' })
    });
    await vi.advanceTimersByTimeAsync(25);

    await dispatch(app, {
      method: 'POST',
      path: '/webhook/receive',
      headers: { [config.sendblueWebhookSecretHeader]: config.sendblueWebhookSecret! },
      body: receivePayload({ message_handle: 'identity-2', from_number: '+15551110002' })
    });
    await vi.advanceTimersByTimeAsync(25);

    expect(chatClient.calls[0].identity).toEqual({ userId: 'user-123', data: { plan: 'pro' } });
    expect(chatClient.calls[1].identity).toBeNull();
  });

  it('sends direct read receipts before chat and refreshes typing until final delivery', async () => {
    await close();
    const refreshedConfig = testConfig({
      bufferBaseTimeoutMs: 25,
      bufferMaxTimeoutMs: 25,
      bufferNoiseMaxDeviation: 0,
      readReceiptsEnabled: true,
      typingRefreshIntervalMs: 10,
      typingRefreshMaxMs: 100,
      outboundDeliveryTimeoutMs: 5000
    });
    const created = createApp({
      config: refreshedConfig,
      chatClient,
      sendblueClient,
      logger: pino({ level: 'silent' })
    });
    app = created.app;
    close = created.close;

    chatClient.responses.push({ messages: ['done'] });
    await dispatch(app, {
      method: 'POST',
      path: '/webhook/receive',
      headers: { [refreshedConfig.sendblueWebhookSecretHeader]: refreshedConfig.sendblueWebhookSecret! },
      body: receivePayload({ message_handle: 'read-typing-1' })
    });

    await vi.advanceTimersByTimeAsync(25);

    expect(sendblueClient.readCalls).toEqual([{ toNumber: '+15551110001' }]);
    expect(chatClient.calls).toHaveLength(1);
    expect(sendblueClient.typingCalls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(20);
    expect(sendblueClient.typingCalls.length).toBeGreaterThan(1);

    await dispatch(app, {
      method: 'POST',
      path: '/webhook/status',
      headers: { [refreshedConfig.sendblueWebhookSecretHeader]: refreshedConfig.sendblueWebhookSecret! },
      body: { message_handle: 'sent-1', status: 'DELIVERED', service: 'iMessage' }
    });
    const stoppedAt = sendblueClient.typingCalls.length;

    await vi.advanceTimersByTimeAsync(30);
    expect(sendblueClient.typingCalls).toHaveLength(stoppedAt);
  });

  it('keeps non-invoked groups silent and routes addressed group mentions', async () => {
    chatClient.responses.push({
      actions: [
        {
          type: 'media',
          content: 'group image',
          mediaUrl: 'https://cdn.example.test/group.png',
          sendStyle: 'balloons'
        }
      ]
    });

    const silent = await dispatch(app, {
      method: 'POST',
      path: '/webhook/receive',
      headers: { [config.sendblueWebhookSecretHeader]: config.sendblueWebhookSecret! },
      body: receivePayload({
        message_handle: 'group-silent-1',
        content: 'talking to the group',
        group_id: 'group-1',
        group_display_name: 'Planning',
        message_type: 'group',
        participants: ['+15551110001', '+15551110002']
      })
    });

    expect(silent.body).toMatchObject({
      ok: true,
      group: true,
      conversationKey: 'group:+15552220000:group-1',
      accepted: false
    });
    expect(chatClient.calls).toHaveLength(0);
    expect(sendblueClient.groupCalls).toHaveLength(0);

    await dispatch(app, {
      method: 'POST',
      path: '/webhook/receive',
      headers: { [config.sendblueWebhookSecretHeader]: config.sendblueWebhookSecret! },
      body: receivePayload({
        message_handle: 'group-invoked-1',
        content: '@sb-agent send the photo',
        group_id: 'group-1',
        group_display_name: 'Planning',
        message_type: 'group',
        participants: ['+15551110001', '+15551110002']
      })
    });
    await vi.advanceTimersByTimeAsync(25);

    expect(chatClient.calls[0].conversation).toMatchObject({
      key: 'group:+15552220000:group-1',
      type: 'group',
      groupId: 'group-1'
    });
    expect(sendblueClient.groupCalls).toEqual([
      {
        groupId: 'group-1',
        content: 'group image',
        mediaUrl: 'https://cdn.example.test/group.png',
        sendStyle: 'balloons',
        statusCallback: 'https://agent.example.test/webhook/status'
      }
    ]);
  });

  it('resolves reaction targets to inbound message handles and continues the queue', async () => {
    chatClient.responses.push({
      actions: [
        { type: 'reaction', reaction: 'love', target: { alias: 'last' } },
        { type: 'message', content: 'after reaction' }
      ]
    });

    await dispatch(app, {
      method: 'POST',
      path: '/webhook/receive',
      headers: { [config.sendblueWebhookSecretHeader]: config.sendblueWebhookSecret! },
      body: receivePayload({ message_handle: 'react-target-1' })
    });
    await vi.advanceTimersByTimeAsync(25);
    await vi.advanceTimersByTimeAsync(0);

    expect(sendblueClient.reactionCalls).toEqual([{ messageHandle: 'react-target-1', reaction: 'love' }]);
    expect(sendblueClient.calls.map(call => call.content)).toEqual(['after reaction']);
  });

  it('treats group replies or tapbacks to known agent outbound handles as addressed', async () => {
    chatClient.responses.push({ actions: [{ type: 'message', content: 'seed group reply' }] }, { silence: true });

    await dispatch(app, {
      method: 'POST',
      path: '/webhook/receive',
      headers: { [config.sendblueWebhookSecretHeader]: config.sendblueWebhookSecret! },
      body: receivePayload({
        message_handle: 'group-seed-1',
        content: '@sb-agent seed',
        group_id: 'group-known',
        message_type: 'group'
      })
    });
    await vi.advanceTimersByTimeAsync(25);

    expect(sendblueClient.groupCalls).toHaveLength(1);

    await dispatch(app, {
      method: 'POST',
      path: '/webhook/status',
      headers: { [config.sendblueWebhookSecretHeader]: config.sendblueWebhookSecret! },
      body: { message_handle: 'group-group-known', status: 'DELIVERED', service: 'iMessage' }
    });

    await dispatch(app, {
      method: 'POST',
      path: '/webhook/receive',
      headers: { [config.sendblueWebhookSecretHeader]: config.sendblueWebhookSecret! },
      body: receivePayload({
        message_handle: 'group-known-reply-1',
        content: 'Reacted love to seed group reply',
        group_id: 'group-known',
        message_type: 'group',
        target_message_handle: 'group-group-known'
      })
    });
    await vi.advanceTimersByTimeAsync(25);

    expect(chatClient.calls).toHaveLength(2);
    expect(chatClient.calls[1].conversation).toMatchObject({
      key: 'group:+15552220000:group-known',
      type: 'group'
    });
  });

  it('does not call chat when VALID_USER_REQUIRED rejects the resolved identity', async () => {
    const resolver: IdentityResolver = {
      resolveByPhone: vi.fn().mockResolvedValue({ userId: 'blocked-user', authorized: false })
    };
    await close();
    const gatedConfig = testConfig({
      bufferBaseTimeoutMs: 25,
      bufferMaxTimeoutMs: 25,
      bufferNoiseMaxDeviation: 0,
      validUserRequired: true
    });
    const created = createApp({
      config: gatedConfig,
      chatClient,
      sendblueClient,
      identityResolver: resolver,
      logger: pino({ level: 'silent' })
    });
    app = created.app;
    close = created.close;

    await dispatch(app, {
      method: 'POST',
      path: '/webhook/receive',
      headers: { [gatedConfig.sendblueWebhookSecretHeader]: gatedConfig.sendblueWebhookSecret! },
      body: receivePayload({ message_handle: 'blocked-identity-1' })
    });
    await vi.advanceTimersByTimeAsync(25);

    expect(chatClient.calls).toHaveLength(0);
    expect(sendblueClient.calls).toHaveLength(0);
  });
});
