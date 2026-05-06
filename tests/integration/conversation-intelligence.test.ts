import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatClient } from '../../src/chat/client.js';
import type { ChatEndpointRequest, ChatEndpointResponse } from '../../src/chat/types.js';
import { createApp } from '../../src/http/app.js';
import type { IdentityResolver } from '../../src/identity/resolver.js';
import type { SendblueClient } from '../../src/sendblue/client.js';
import type {
  SendblueOutboundMessage,
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
  typingCalls: SendblueTypingIndicator[] = [];

  async sendMessage(message: SendblueOutboundMessage): Promise<SendblueSendResult> {
    this.calls.push(message);
    return { messageHandle: `sent-${this.calls.length}`, raw: { ok: true } };
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
});
