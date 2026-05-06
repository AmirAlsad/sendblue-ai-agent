import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatEndpointError, HttpChatClient, normalizeChatResponse } from '../../src/chat/client.js';
import { createChatRequest, type ChatEndpointRequest } from '../../src/chat/types.js';
import { parseReceiveWebhook } from '../../src/sendblue/parser.js';
import { loadFixture } from '../helpers/fixtures.js';
import { testConfig } from '../helpers/config.js';

describe('chat endpoint contract', () => {
  it('normalizes single-message, multi-message, and silence responses', () => {
    expect(normalizeChatResponse({ message: 'hello' })).toEqual({
      actions: [{ type: 'message', content: 'hello' }]
    });
    expect(normalizeChatResponse({ messages: ['one', '', 'two'] })).toEqual({
      actions: [
        { type: 'message', content: 'one' },
        { type: 'message', content: 'two' }
      ]
    });
    expect(normalizeChatResponse({ silence: true })).toEqual({ silence: true, actions: [] });
  });

  it('rejects malformed chat responses', () => {
    expect(() => normalizeChatResponse({ ok: true })).toThrow(/message, messages, actions, or silence/);
  });

  it('includes Sendblue metadata and downgrade state in requests', () => {
    const webhook = parseReceiveWebhook(loadFixture('sendblue/receive-downgraded.json'));
    const request = createChatRequest(webhook);

    expect(request).toMatchObject({
      message: 'sms fallback hello',
      fromNumber: '+15551110004',
      toNumber: '+15552220000',
      messageHandle: 'recv-downgraded-001',
      channel: 'sms',
      sendblue: {
        wasDowngraded: true,
        service: 'SMS'
      }
    });
  });

  it('maps observed SMS service and group metadata into chat requests', () => {
    const sms = createChatRequest(
      parseReceiveWebhook(loadFixture<{ body: unknown }>('sendblue/captured/observed/sms-fallback.json').body)
    );
    expect(sms).toMatchObject({
      channel: 'sms',
      sendblue: {
        wasDowngraded: false,
        service: 'SMS'
      }
    });

    const group = createChatRequest(
      parseReceiveWebhook(loadFixture<{ body: unknown }>('sendblue/captured/observed/group-message.json').body)
    );
    expect(group).toMatchObject({
      channel: 'imessage',
      sendblue: {
        groupId: 'observed-group-001',
        groupDisplayName: '',
        participants: ['+15550000001', '+15550000002', '+15550000003', '+15550000004']
      }
    });
  });
});

describe('HttpChatClient', () => {
  const fetchMock = vi.fn();
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function buildRequest(): ChatEndpointRequest {
    const webhook = parseReceiveWebhook(loadFixture('sendblue/receive-downgraded.json'));
    const base = createChatRequest(webhook);
    return {
      ...base,
      messages: [
        {
          content: 'sms fallback hello',
          fromNumber: '+15551110004',
          toNumber: '+15552220000',
          messageHandle: 'recv-downgraded-001',
          channel: 'sms',
          mediaUrl: null,
          messageType: null,
          sendStyle: null,
          raw: webhook.raw
        }
      ],
      conversation: {
        key: 'direct:+15552220000:+15551110004',
        type: 'direct',
        lineNumber: '+15552220000',
        phoneNumber: '+15551110004',
        channel: 'sms',
        smsDowngraded: true,
        state: 'processing'
      },
      identity: { userId: 'user-123', authorized: true },
      typing: { isTyping: false, receivedAt: '2025-01-01T00:00:00.000Z' }
    };
  }

  it('POSTs the structured request to the configured chat endpoint and normalizes the response', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ message: 'hi back' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
    const client = new HttpChatClient(testConfig());
    const request = buildRequest();
    const response = await client.complete(request);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://chat.example.test/chat');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'content-type': 'application/json' });
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      message: 'sms fallback hello',
      messageHandle: 'recv-downgraded-001',
      channel: 'sms',
      conversation: { type: 'direct', smsDowngraded: true },
      identity: { userId: 'user-123', authorized: true },
      typing: { isTyping: false },
      sendblue: { wasDowngraded: true }
    });
    expect(response).toEqual({ actions: [{ type: 'message', content: 'hi back' }] });
  });

  it('throws ChatEndpointError on non-2xx responses with the upstream status', async () => {
    fetchMock.mockResolvedValue(new Response('boom', { status: 503 }));
    const client = new HttpChatClient(testConfig());
    await expect(client.complete(buildRequest())).rejects.toMatchObject({
      name: 'ChatEndpointError',
      message: expect.stringContaining('503')
    });
  });

  it('wraps fetch failures (network/abort) as ChatEndpointError preserving the cause', async () => {
    const cause = new Error('network down');
    fetchMock.mockRejectedValue(cause);
    const client = new HttpChatClient(testConfig());
    await expect(client.complete(buildRequest())).rejects.toMatchObject({
      name: 'ChatEndpointError',
      cause
    });
  });

  it('honors chatResponseParseTags=false for legacy string responses', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ message: '<message>literal</message>' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
    const client = new HttpChatClient(testConfig({ chatResponseParseTags: false }));
    const response = await client.complete(buildRequest());
    expect(response).toEqual({
      actions: [{ type: 'message', content: '<message>literal</message>' }]
    });
  });

  it('rethrows the same ChatEndpointError instance when the upstream is malformed', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
    const client = new HttpChatClient(testConfig());
    await expect(client.complete(buildRequest())).rejects.toBeInstanceOf(ChatEndpointError);
  });
});
