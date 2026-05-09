import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatClient } from '../../src/chat/client.js';
import type { ChatEndpointRequest, ChatEndpointResponse } from '../../src/chat/types.js';
import { createApp } from '../../src/http/app.js';
import type { IdentityResolver } from '../../src/identity/resolver.js';
import type { ConversationIdentity } from '../../src/conversation/types.js';
import type { SendblueClient } from '../../src/sendblue/client.js';
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
  contactCalls: SendblueContactRequest[] = [];

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
    // Mirror production: Sendblue's send-reaction endpoint returns a
    // message_handle on success even though no DELIVERED/SENT status
    // callback is ever emitted for it. This fake's previous shape (no
    // handle) accidentally hid a real bug where the agent would map the
    // returned handle and stall the queue waiting 30s for a status
    // callback that never arrives.
    return {
      status: 'OK',
      reaction: reaction.reaction,
      messageHandle: `reaction-handle-${this.reactionCalls.length}`,
      raw: { ok: true }
    };
  }

  async markRead(receipt: SendblueMarkReadRequest): Promise<SendblueActionResult> {
    this.readCalls.push(receipt);
    return { status: 'OK', number: receipt.toNumber, raw: { ok: true } };
  }

  async sendTypingIndicator(indicator: SendblueTypingIndicator): Promise<SendblueTypingIndicatorResult> {
    this.typingCalls.push(indicator);
    return { status: 'SENT', raw: { ok: true } };
  }

  async createContact(contact: SendblueContactRequest): Promise<SendblueContactResult> {
    this.contactCalls.push(contact);
    return { number: contact.number, raw: { ok: true } };
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

  it('attaches inbound typing to an existing conversation even if number fields are reversed', async () => {
    chatClient.responses.push({ silence: true }, { silence: true });

    await dispatch(app, {
      method: 'POST',
      path: '/webhook/receive',
      headers: { [config.sendblueWebhookSecretHeader]: config.sendblueWebhookSecret! },
      body: receivePayload({ message_handle: 'typing-seed', content: 'seed' })
    });
    await vi.advanceTimersByTimeAsync(25);

    await dispatch(app, {
      method: 'POST',
      path: '/webhook/typing-indicator',
      headers: { [config.sendblueWebhookSecretHeader]: config.sendblueWebhookSecret! },
      body: {
        number: '+15552220000',
        from_number: '+15551110001',
        is_typing: true,
        timestamp: '2026-05-06T12:01:00.000Z'
      }
    });

    await dispatch(app, {
      method: 'POST',
      path: '/webhook/receive',
      headers: { [config.sendblueWebhookSecretHeader]: config.sendblueWebhookSecret! },
      body: receivePayload({ message_handle: 'typing-reversed-next', content: 'after typing' })
    });
    await vi.advanceTimersByTimeAsync(25);

    expect(chatClient.calls[1].typing).toMatchObject({
      isTyping: true,
      timestamp: '2026-05-06T12:01:00.000Z'
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

  it('sends read receipts before chat and stops typing as soon as the chat returns', async () => {
    await close();
    const refreshedConfig = testConfig({
      bufferBaseTimeoutMs: 25,
      bufferMaxTimeoutMs: 25,
      bufferNoiseMaxDeviation: 0,
      readReceiptsEnabled: true,
      typingStartDelayMs: 0,
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

    // Hold the chat response open so we can observe typing while in flight.
    let resolveChat!: (response: ChatEndpointResponse) => void;
    const pendingChat = new Promise<ChatEndpointResponse>(resolve => {
      resolveChat = resolve;
    });
    chatClient.responses.push(pendingChat);

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

    // Refresh fires while we're still waiting on the chat response.
    await vi.advanceTimersByTimeAsync(25);
    expect(sendblueClient.typingCalls.length).toBeGreaterThan(1);

    // Chat returns — typing should stop here, before the message even goes out.
    // Refreshing during sending only risks lighting up a phantom bubble: the
    // device-side iMessage typing indicator persists ~60s after the last call
    // regardless of refresh, and arriving messages clear it anyway.
    resolveChat({ messages: ['done'] });
    await vi.advanceTimersByTimeAsync(0);
    const stoppedAt = sendblueClient.typingCalls.length;

    await vi.advanceTimersByTimeAsync(50);
    expect(sendblueClient.typingCalls).toHaveLength(stoppedAt);

    // DELIVERED status is now well after typing has stopped — make sure it
    // doesn't accidentally restart the indicator.
    await dispatch(app, {
      method: 'POST',
      path: '/webhook/status',
      headers: { [refreshedConfig.sendblueWebhookSecretHeader]: refreshedConfig.sendblueWebhookSecret! },
      body: { message_handle: 'sent-1', status: 'DELIVERED', service: 'iMessage' }
    });
    await vi.advanceTimersByTimeAsync(30);
    expect(sendblueClient.typingCalls).toHaveLength(stoppedAt);
  });

  it('skips the typing indicator entirely when the chat returns silence within the start delay', async () => {
    await close();
    const silenceConfig = testConfig({
      bufferBaseTimeoutMs: 25,
      bufferMaxTimeoutMs: 25,
      bufferNoiseMaxDeviation: 0,
      typingStartDelayMs: 200,
      typingRefreshIntervalMs: 50,
      typingRefreshMaxMs: 1000,
      outboundDeliveryTimeoutMs: 5000
    });
    const created = createApp({
      config: silenceConfig,
      chatClient,
      sendblueClient,
      logger: pino({ level: 'silent' })
    });
    app = created.app;
    close = created.close;

    chatClient.responses.push({ silence: true });
    await dispatch(app, {
      method: 'POST',
      path: '/webhook/receive',
      headers: { [silenceConfig.sendblueWebhookSecretHeader]: silenceConfig.sendblueWebhookSecret! },
      body: receivePayload({ message_handle: 'silence-1' })
    });

    await vi.advanceTimersByTimeAsync(25);
    expect(chatClient.calls).toHaveLength(1);
    // Chat returned silence; agent should never have fired the typing call.
    expect(sendblueClient.typingCalls).toHaveLength(0);

    // Even after the start delay elapses, no typing call fires because the
    // refresh was cancelled when the silence response was consumed.
    await vi.advanceTimersByTimeAsync(500);
    expect(sendblueClient.typingCalls).toHaveLength(0);
  });

  it('fires a brief typing indicator between queued outbound messages', async () => {
    await close();
    const interConfig = testConfig({
      bufferBaseTimeoutMs: 25,
      bufferMaxTimeoutMs: 25,
      bufferNoiseMaxDeviation: 0,
      typingStartDelayMs: 200,
      typingRefreshIntervalMs: 50,
      typingRefreshMaxMs: 1000,
      outboundDeliveryTimeoutMs: 5000
    });
    const created = createApp({
      config: interConfig,
      chatClient,
      sendblueClient,
      logger: pino({ level: 'silent' })
    });
    app = created.app;
    close = created.close;

    chatClient.responses.push({
      actions: [
        { type: 'message', content: 'first' },
        { type: 'message', content: 'second' }
      ]
    });

    await dispatch(app, {
      method: 'POST',
      path: '/webhook/receive',
      headers: { [interConfig.sendblueWebhookSecretHeader]: interConfig.sendblueWebhookSecret! },
      body: receivePayload({ message_handle: 'inter-multi-1' })
    });

    await vi.advanceTimersByTimeAsync(25);
    expect(sendblueClient.calls).toHaveLength(1);
    // No typing yet — first message went out under the start delay.
    expect(sendblueClient.typingCalls).toHaveLength(0);

    // Deliver the first message; queue advances and sends the second. A
    // single inter-message typing call should fire just before the second
    // send goes out.
    await dispatch(app, {
      method: 'POST',
      path: '/webhook/status',
      headers: { [interConfig.sendblueWebhookSecretHeader]: interConfig.sendblueWebhookSecret! },
      body: { message_handle: 'sent-1', status: 'DELIVERED', service: 'iMessage' }
    });

    expect(sendblueClient.calls).toHaveLength(2);
    expect(sendblueClient.typingCalls).toHaveLength(1);

    // Inter-message typing is one-shot — no refresh follow-up.
    await vi.advanceTimersByTimeAsync(500);
    expect(sendblueClient.typingCalls).toHaveLength(1);
  });

  it('skips the typing indicator when the chat returns multiple actions within the start delay', async () => {
    await close();
    const fastConfig = testConfig({
      bufferBaseTimeoutMs: 25,
      bufferMaxTimeoutMs: 25,
      bufferNoiseMaxDeviation: 0,
      typingStartDelayMs: 200,
      typingRefreshIntervalMs: 50,
      typingRefreshMaxMs: 1000,
      outboundDeliveryTimeoutMs: 5000
    });
    const created = createApp({
      config: fastConfig,
      chatClient,
      sendblueClient,
      logger: pino({ level: 'silent' })
    });
    app = created.app;
    close = created.close;

    // Two ordered messages — same shape as the action-catalog `multi` keyword.
    chatClient.responses.push({
      actions: [
        { type: 'message', content: 'first' },
        { type: 'message', content: 'second' }
      ]
    });

    await dispatch(app, {
      method: 'POST',
      path: '/webhook/receive',
      headers: { [fastConfig.sendblueWebhookSecretHeader]: fastConfig.sendblueWebhookSecret! },
      body: receivePayload({ message_handle: 'multi-1' })
    });

    await vi.advanceTimersByTimeAsync(25);
    expect(chatClient.calls).toHaveLength(1);
    expect(sendblueClient.calls.length).toBeGreaterThan(0);

    // Chat returned multiple actions within the start delay. The first message
    // has already been queued — the pending typing-start timer must have been
    // cancelled before it could fire.
    await vi.advanceTimersByTimeAsync(500);
    expect(sendblueClient.typingCalls).toHaveLength(0);
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

  it('advances the queue immediately after a reaction without waiting for a status callback', async () => {
    // Sendblue's /api/send-reaction does not emit DELIVERED/SENT status
    // callbacks. If the agent tracks the returned message_handle the way
    // it does for normal sends, the next outbound stalls until
    // OUTBOUND_DELIVERY_TIMEOUT_MS fires (default 30s). This test pins the
    // fix: the message after a reaction must go out within the same
    // synchronous tick as the chat response.
    chatClient.responses.push({
      actions: [
        { type: 'reaction', reaction: 'like', target: { alias: 'last' } },
        { type: 'message', content: 'follow-up' }
      ]
    });

    await dispatch(app, {
      method: 'POST',
      path: '/webhook/receive',
      headers: { [config.sendblueWebhookSecretHeader]: config.sendblueWebhookSecret! },
      body: receivePayload({ message_handle: 'react-no-stall-1' })
    });

    // Buffer flush plus a single async tick — enough for the chat response
    // to come back, the reaction to send, and the queue to advance to the
    // follow-up message. Crucially, far less than the 30s delivery timeout.
    await vi.advanceTimersByTimeAsync(25);
    await vi.advanceTimersByTimeAsync(0);

    expect(sendblueClient.reactionCalls).toHaveLength(1);
    expect(sendblueClient.calls.map(call => call.content)).toEqual(['follow-up']);
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

  it('preserves reply intent in the chat contract but sends a normal Sendblue direct message', async () => {
    chatClient.responses.push({
      actions: [{ type: 'reply', target: { alias: 'last' }, content: 'plain Sendblue fallback reply' }]
    });

    await dispatch(app, {
      method: 'POST',
      path: '/webhook/receive',
      headers: { [config.sendblueWebhookSecretHeader]: config.sendblueWebhookSecret! },
      body: receivePayload({ message_handle: 'reply-target-1', content: 'reply to me' })
    });
    await vi.advanceTimersByTimeAsync(25);

    expect(sendblueClient.calls).toEqual([
      {
        toNumber: '+15551110001',
        content: 'plain Sendblue fallback reply',
        statusCallback: 'https://agent.example.test/webhook/status'
      }
    ]);
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

  it('treats group replies that contain a prior agent message as a substring as addressed (default fallback)', async () => {
    chatClient.responses.push({ actions: [{ type: 'message', content: 'yes' }] }, { silence: true });

    await dispatch(app, {
      method: 'POST',
      path: '/webhook/receive',
      headers: { [config.sendblueWebhookSecretHeader]: config.sendblueWebhookSecret! },
      body: receivePayload({
        message_handle: 'group-fallback-seed-1',
        content: '@sb-agent should we?',
        group_id: 'group-fallback',
        message_type: 'group'
      })
    });
    await vi.advanceTimersByTimeAsync(25);

    expect(sendblueClient.groupCalls).toHaveLength(1);

    await dispatch(app, {
      method: 'POST',
      path: '/webhook/status',
      headers: { [config.sendblueWebhookSecretHeader]: config.sendblueWebhookSecret! },
      body: { message_handle: 'group-group-fallback', status: 'DELIVERED', service: 'iMessage' }
    });

    await dispatch(app, {
      method: 'POST',
      path: '/webhook/receive',
      headers: { [config.sendblueWebhookSecretHeader]: config.sendblueWebhookSecret! },
      body: receivePayload({
        message_handle: 'group-fallback-followup-1',
        content: 'yes please go ahead',
        group_id: 'group-fallback',
        message_type: 'group'
      })
    });
    await vi.advanceTimersByTimeAsync(25);

    expect(chatClient.calls).toHaveLength(2);
  });

  it('ignores prior-message substring fallback when GROUP_INVOCATION_CONTENT_FALLBACK is off', async () => {
    await close();
    const tightConfig = testConfig({
      bufferBaseTimeoutMs: 25,
      bufferMaxTimeoutMs: 25,
      bufferNoiseMaxDeviation: 0,
      groupInvocationContentFallback: false
    });
    const created = createApp({
      config: tightConfig,
      chatClient,
      sendblueClient,
      logger: pino({ level: 'silent' })
    });
    app = created.app;
    close = created.close;
    chatClient.responses.push({ actions: [{ type: 'message', content: 'yes' }] }, { silence: true });

    await dispatch(app, {
      method: 'POST',
      path: '/webhook/receive',
      headers: { [tightConfig.sendblueWebhookSecretHeader]: tightConfig.sendblueWebhookSecret! },
      body: receivePayload({
        message_handle: 'group-tight-seed-1',
        content: '@sb-agent should we?',
        group_id: 'group-tight',
        message_type: 'group'
      })
    });
    await vi.advanceTimersByTimeAsync(25);

    expect(sendblueClient.groupCalls).toHaveLength(1);

    await dispatch(app, {
      method: 'POST',
      path: '/webhook/status',
      headers: { [tightConfig.sendblueWebhookSecretHeader]: tightConfig.sendblueWebhookSecret! },
      body: { message_handle: 'group-group-tight', status: 'DELIVERED', service: 'iMessage' }
    });

    await dispatch(app, {
      method: 'POST',
      path: '/webhook/receive',
      headers: { [tightConfig.sendblueWebhookSecretHeader]: tightConfig.sendblueWebhookSecret! },
      body: receivePayload({
        message_handle: 'group-tight-followup-1',
        content: 'yes please go ahead',
        group_id: 'group-tight',
        message_type: 'group'
      })
    });
    await vi.advanceTimersByTimeAsync(25);

    // Substring fallback disabled — second inbound is acknowledged but does NOT
    // invoke the chat endpoint (no @sb-agent mention, no reply metadata).
    expect(chatClient.calls).toHaveLength(1);
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

  it('drops iMessage send effects on downgraded SMS conversations but still sends text', async () => {
    chatClient.responses.push({
      actions: [
        {
          type: 'message',
          content: 'sms text',
          sendStyle: 'celebration'
        }
      ]
    });

    await dispatch(app, {
      method: 'POST',
      path: '/webhook/receive',
      headers: { [config.sendblueWebhookSecretHeader]: config.sendblueWebhookSecret! },
      body: receivePayload({
        message_handle: 'sms-effect-1',
        content: 'hello sms',
        service: 'SMS',
        was_downgraded: true
      })
    });
    await vi.advanceTimersByTimeAsync(25);

    expect(sendblueClient.calls).toEqual([
      {
        toNumber: '+15551110001',
        content: 'sms text',
        statusCallback: 'https://agent.example.test/webhook/status'
      }
    ]);
  });

  it('skips reactions on SMS or downgraded conversations and continues the queue', async () => {
    chatClient.responses.push({
      actions: [
        { type: 'reaction', reaction: 'love', target: { alias: 'last' } },
        { type: 'message', content: 'after suppressed reaction' }
      ]
    });

    await dispatch(app, {
      method: 'POST',
      path: '/webhook/receive',
      headers: { [config.sendblueWebhookSecretHeader]: config.sendblueWebhookSecret! },
      body: receivePayload({
        message_handle: 'sms-react-1',
        content: 'react if you can',
        service: 'SMS',
        was_downgraded: true
      })
    });
    await vi.advanceTimersByTimeAsync(25);

    expect(sendblueClient.reactionCalls).toEqual([]);
    expect(sendblueClient.calls.map(call => call.content)).toEqual(['after suppressed reaction']);
  });

  it('sends a read receipt on RCS conversations (mark-read supports RCS per Sendblue docs)', async () => {
    await close();
    const rcsConfig = testConfig({
      bufferBaseTimeoutMs: 25,
      bufferMaxTimeoutMs: 25,
      bufferNoiseMaxDeviation: 0,
      readReceiptsEnabled: true
    });
    const created = createApp({
      config: rcsConfig,
      chatClient,
      sendblueClient,
      logger: pino({ level: 'silent' })
    });
    app = created.app;
    close = created.close;
    chatClient.responses.push({ silence: true });

    await dispatch(app, {
      method: 'POST',
      path: '/webhook/receive',
      headers: { [rcsConfig.sendblueWebhookSecretHeader]: rcsConfig.sendblueWebhookSecret! },
      body: receivePayload({
        message_handle: 'rcs-read-1',
        content: 'hello rcs',
        service: 'RCS'
      })
    });
    await vi.advanceTimersByTimeAsync(25);

    expect(sendblueClient.readCalls).toEqual([{ toNumber: '+15551110001' }]);
  });

  it('does not send a read receipt on SMS or downgraded conversations', async () => {
    await close();
    const smsConfig = testConfig({
      bufferBaseTimeoutMs: 25,
      bufferMaxTimeoutMs: 25,
      bufferNoiseMaxDeviation: 0,
      readReceiptsEnabled: true
    });
    const created = createApp({
      config: smsConfig,
      chatClient,
      sendblueClient,
      logger: pino({ level: 'silent' })
    });
    app = created.app;
    close = created.close;
    chatClient.responses.push({ silence: true }, { silence: true });

    await dispatch(app, {
      method: 'POST',
      path: '/webhook/receive',
      headers: { [smsConfig.sendblueWebhookSecretHeader]: smsConfig.sendblueWebhookSecret! },
      body: receivePayload({
        message_handle: 'sms-read-1',
        content: 'hello sms',
        service: 'SMS'
      })
    });
    await vi.advanceTimersByTimeAsync(25);

    await dispatch(app, {
      method: 'POST',
      path: '/webhook/receive',
      headers: { [smsConfig.sendblueWebhookSecretHeader]: smsConfig.sendblueWebhookSecret! },
      body: receivePayload({
        message_handle: 'downgraded-read-1',
        content: 'still downgraded',
        service: 'SMS',
        was_downgraded: true
      })
    });
    await vi.advanceTimersByTimeAsync(25);

    expect(sendblueClient.readCalls).toEqual([]);
  });

  it('keeps the same conversation record across an iMessage to SMS downgrade', async () => {
    chatClient.responses.push({ silence: true }, { silence: true });

    await dispatch(app, {
      method: 'POST',
      path: '/webhook/receive',
      headers: { [config.sendblueWebhookSecretHeader]: config.sendblueWebhookSecret! },
      body: receivePayload({ message_handle: 'persist-imessage-1', content: 'before', service: 'iMessage' })
    });
    await vi.advanceTimersByTimeAsync(25);

    await dispatch(app, {
      method: 'POST',
      path: '/webhook/receive',
      headers: { [config.sendblueWebhookSecretHeader]: config.sendblueWebhookSecret! },
      body: receivePayload({
        message_handle: 'persist-sms-2',
        content: 'after downgrade',
        service: 'SMS',
        was_downgraded: true
      })
    });
    await vi.advanceTimersByTimeAsync(25);

    expect(chatClient.calls).toHaveLength(2);
    expect(chatClient.calls[0].conversation?.key).toBe('direct:+15552220000:+15551110001');
    expect(chatClient.calls[1].conversation?.key).toBe('direct:+15552220000:+15551110001');
    expect(chatClient.calls[1].conversation?.smsDowngraded).toBe(true);
    expect(chatClient.calls[1].channel).toBe('sms');
  });

  it('clears smsDowngraded when a previously-downgraded conversation receives a fresh iMessage', async () => {
    chatClient.responses.push({ silence: true }, { silence: true }, { silence: true });

    await dispatch(app, {
      method: 'POST',
      path: '/webhook/receive',
      headers: { [config.sendblueWebhookSecretHeader]: config.sendblueWebhookSecret! },
      body: receivePayload({ message_handle: 'cycle-imessage-1', content: 'first', service: 'iMessage' })
    });
    await vi.advanceTimersByTimeAsync(25);

    await dispatch(app, {
      method: 'POST',
      path: '/webhook/receive',
      headers: { [config.sendblueWebhookSecretHeader]: config.sendblueWebhookSecret! },
      body: receivePayload({
        message_handle: 'cycle-sms-2',
        content: 'downgraded',
        service: 'SMS',
        was_downgraded: true
      })
    });
    await vi.advanceTimersByTimeAsync(25);

    await dispatch(app, {
      method: 'POST',
      path: '/webhook/receive',
      headers: { [config.sendblueWebhookSecretHeader]: config.sendblueWebhookSecret! },
      body: receivePayload({ message_handle: 'cycle-imessage-3', content: 'back on iMessage', service: 'iMessage' })
    });
    await vi.advanceTimersByTimeAsync(25);

    expect(chatClient.calls).toHaveLength(3);
    expect(chatClient.calls[1].conversation?.smsDowngraded).toBe(true);
    expect(chatClient.calls[2].conversation?.smsDowngraded).toBe(false);
    expect(chatClient.calls[2].channel).toBe('imessage');
  });

  it('aborts the queue and stops typing on ERROR status', async () => {
    chatClient.responses.push({ messages: ['first', 'second'] });

    await dispatch(app, {
      method: 'POST',
      path: '/webhook/receive',
      headers: { [config.sendblueWebhookSecretHeader]: config.sendblueWebhookSecret! },
      body: receivePayload({ message_handle: 'error-abort-1', content: 'hello' })
    });
    await vi.advanceTimersByTimeAsync(25);

    expect(sendblueClient.calls).toHaveLength(1);

    await dispatch(app, {
      method: 'POST',
      path: '/webhook/status',
      headers: { [config.sendblueWebhookSecretHeader]: config.sendblueWebhookSecret! },
      body: {
        message_handle: 'sent-1',
        status: 'ERROR',
        service: 'iMessage',
        error_code: '4002',
        error_message: 'recipient unreachable'
      }
    });

    // Queue must abort: the second message must NOT be sent.
    expect(sendblueClient.calls).toHaveLength(1);
  });
});

describe('contact upsert on inbound', () => {
  const baseConfig = testConfig({
    bufferBaseTimeoutMs: 25,
    bufferMaxTimeoutMs: 25,
    bufferNoiseMaxDeviation: 0,
    sendblueContactsEnabled: true,
    sendblueContactsDefaultTags: ['agent']
  });
  let chatClient: QueueChatClient;
  let sendblueClient: FakeSendblueClient;
  let close: () => Promise<void>;
  let app: ReturnType<typeof createApp>['app'];

  beforeEach(() => {
    vi.useFakeTimers();
    chatClient = new QueueChatClient();
    sendblueClient = new FakeSendblueClient();
  });

  afterEach(async () => {
    await close();
    vi.useRealTimers();
  });

  function bootWithResolver(resolver: IdentityResolver, configOverrides: Partial<typeof baseConfig> = {}) {
    const finalConfig = { ...baseConfig, ...configOverrides };
    const created = createApp({
      config: finalConfig,
      chatClient,
      sendblueClient,
      identityResolver: resolver,
      logger: pino({ level: 'silent' })
    });
    app = created.app;
    close = created.close;
    return finalConfig;
  }

  it('upserts a contact for direct inbound when identity returns a name', async () => {
    const resolver: IdentityResolver = {
      resolveByPhone: vi.fn().mockResolvedValue({
        userId: 'u-1',
        firstName: 'Ada',
        lastName: 'Lovelace',
        tags: ['tier:gold']
      })
    };
    const finalConfig = bootWithResolver(resolver);
    chatClient.responses.push({ silence: true });

    await dispatch(app, {
      method: 'POST',
      path: '/webhook/receive',
      headers: { [finalConfig.sendblueWebhookSecretHeader]: finalConfig.sendblueWebhookSecret! },
      body: receivePayload({ message_handle: 'contact-direct-1', from_number: '+15551110001' })
    });
    await vi.advanceTimersByTimeAsync(25);
    // Drain microtasks for the fire-and-forget upsert.
    await vi.runAllTimersAsync();

    expect(sendblueClient.contactCalls).toHaveLength(1);
    expect(sendblueClient.contactCalls[0]).toMatchObject({
      number: '+15551110001',
      firstName: 'Ada',
      lastName: 'Lovelace',
      sendblueNumber: '+15552220000',
      tags: ['agent', 'tier:gold'],
      updateIfExists: true
    });
  });

  it('skips contact upsert when identity has no name', async () => {
    const resolver: IdentityResolver = {
      resolveByPhone: vi.fn().mockResolvedValue({ userId: 'u-2', data: { plan: 'pro' } })
    };
    const finalConfig = bootWithResolver(resolver);
    chatClient.responses.push({ silence: true });

    await dispatch(app, {
      method: 'POST',
      path: '/webhook/receive',
      headers: { [finalConfig.sendblueWebhookSecretHeader]: finalConfig.sendblueWebhookSecret! },
      body: receivePayload({ message_handle: 'contact-noname-1' })
    });
    await vi.advanceTimersByTimeAsync(25);
    await vi.runAllTimersAsync();

    expect(sendblueClient.contactCalls).toHaveLength(0);
  });

  it('skips contact upsert when SENDBLUE_CONTACTS_ENABLED is false', async () => {
    const resolver: IdentityResolver = {
      resolveByPhone: vi.fn().mockResolvedValue({ userId: 'u-3', firstName: 'Ada' })
    };
    const finalConfig = bootWithResolver(resolver, { sendblueContactsEnabled: false });
    chatClient.responses.push({ silence: true });

    await dispatch(app, {
      method: 'POST',
      path: '/webhook/receive',
      headers: { [finalConfig.sendblueWebhookSecretHeader]: finalConfig.sendblueWebhookSecret! },
      body: receivePayload({ message_handle: 'contact-disabled-1' })
    });
    await vi.advanceTimersByTimeAsync(25);
    await vi.runAllTimersAsync();

    expect(sendblueClient.contactCalls).toHaveLength(0);
  });

  it('dedupes per (line, number): second inbound from the same number does not re-upsert', async () => {
    const resolver: IdentityResolver = {
      resolveByPhone: vi.fn().mockResolvedValue({ userId: 'u-1', firstName: 'Ada' })
    };
    const finalConfig = bootWithResolver(resolver);
    chatClient.responses.push({ silence: true }, { silence: true });

    await dispatch(app, {
      method: 'POST',
      path: '/webhook/receive',
      headers: { [finalConfig.sendblueWebhookSecretHeader]: finalConfig.sendblueWebhookSecret! },
      body: receivePayload({ message_handle: 'dedupe-1', from_number: '+15551110001' })
    });
    await vi.advanceTimersByTimeAsync(25);
    await vi.runAllTimersAsync();

    await dispatch(app, {
      method: 'POST',
      path: '/webhook/receive',
      headers: { [finalConfig.sendblueWebhookSecretHeader]: finalConfig.sendblueWebhookSecret! },
      body: receivePayload({ message_handle: 'dedupe-2', from_number: '+15551110001' })
    });
    await vi.advanceTimersByTimeAsync(25);
    await vi.runAllTimersAsync();

    expect(sendblueClient.contactCalls).toHaveLength(1);
  });

  it('iterates group participants, gates each by identity name, skips lineNumber and self', async () => {
    const known = new Map<string, ConversationIdentity>([
      ['+15551110002', { userId: 'u-2', firstName: 'Ada' }],
      ['+15551110003', { userId: 'u-3', firstName: 'Grace' }]
    ]);
    const resolver: IdentityResolver = {
      resolveByPhone: vi.fn().mockImplementation(async ({ phoneNumber }: { phoneNumber: string }) => {
        return known.get(phoneNumber) ?? null;
      })
    };
    const finalConfig = bootWithResolver(resolver, {
      // Enable group invocation by default-display-name mention so the
      // group flow doesn't return early.
      agentDisplayName: 'sb-agent'
    });
    chatClient.responses.push({ silence: true });

    await dispatch(app, {
      method: 'POST',
      path: '/webhook/receive',
      headers: { [finalConfig.sendblueWebhookSecretHeader]: finalConfig.sendblueWebhookSecret! },
      body: {
        ...loadFixture<Record<string, unknown>>('sendblue/receive-media-group.json'),
        message_handle: 'group-contact-1',
        from_number: '+15551110002',
        content: '@sb-agent hello',
        // Include the line number to verify it's skipped.
        participants: ['+15551110002', '+15551110003', '+15552220000']
      }
    });
    await vi.advanceTimersByTimeAsync(25);
    await vi.runAllTimersAsync();

    const numbers = sendblueClient.contactCalls.map(c => c.number).sort();
    expect(numbers).toEqual(['+15551110002', '+15551110003']);
  });

  it('does not block message processing when contact upsert throws', async () => {
    const resolver: IdentityResolver = {
      resolveByPhone: vi.fn().mockResolvedValue({ userId: 'u-1', firstName: 'Ada' })
    };
    const finalConfig = bootWithResolver(resolver);
    sendblueClient.createContact = vi.fn().mockRejectedValue(new Error('contacts api down'));
    chatClient.responses.push({ messages: ['hello back'] });

    await dispatch(app, {
      method: 'POST',
      path: '/webhook/receive',
      headers: { [finalConfig.sendblueWebhookSecretHeader]: finalConfig.sendblueWebhookSecret! },
      body: receivePayload({ message_handle: 'contact-throw-1' })
    });
    await vi.advanceTimersByTimeAsync(25);
    await vi.runAllTimersAsync();

    // Chat call still happened; outbound message was still sent.
    expect(chatClient.calls).toHaveLength(1);
    expect(sendblueClient.calls).toHaveLength(1);
  });
});
