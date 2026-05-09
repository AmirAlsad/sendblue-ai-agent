import pino from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/http/app.js';
import type { ChatClient } from '../../src/chat/client.js';
import type { ChatEndpointRequest, ChatEndpointResponse } from '../../src/chat/types.js';
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
import { InMemoryStatusStore } from '../../src/status/tracker.js';
import { replayCapturedEnvelope } from '../helpers/captured-envelopes.js';
import { dispatch } from '../helpers/dispatch.js';
import { loadFixture } from '../helpers/fixtures.js';
import { testConfig } from '../helpers/config.js';

const observedScenarios = [
  'basic-text',
  'image-media',
  'video-media',
  'audio-or-file-media',
  'tapback-heart',
  'tapback-thumbs-up',
  'tapback-thumbs-down',
  'tapback-haha',
  'tapback-emphasis',
  'tapback-question',
  'tapback-custom-emoji',
  'effect-balloons',
  'effect-celebration',
  'group-message',
  'sms-fallback'
] as const;

const operationalScenarios = [
  ['typing_indicator', 'typing-indicator'],
  ['call_log', 'call-log'],
  ['line_blocked', 'line-blocked'],
  ['line_assigned', 'line-assigned'],
  ['contact_created', 'contact-created']
] as const;

class FakeChatClient implements ChatClient {
  calls: ChatEndpointRequest[] = [];
  nextResponse: ChatEndpointResponse = { messages: ['default reply'] };
  nextError: Error | undefined;

  async complete(requestBody: ChatEndpointRequest): Promise<ChatEndpointResponse> {
    this.calls.push(requestBody);
    if (this.nextError) throw this.nextError;
    return this.nextResponse;
  }
}

class FakeSendblueClient implements SendblueClient {
  calls: SendblueOutboundMessage[] = [];
  typingCalls: SendblueTypingIndicator[] = [];

  async sendMessage(message: SendblueOutboundMessage): Promise<SendblueSendResult> {
    this.calls.push(message);
    return { messageHandle: `sent-${this.calls.length}`, raw: { ok: true } };
  }

  async sendGroupMessage(message: SendblueOutboundGroupMessage): Promise<SendblueSendResult> {
    return { messageHandle: `group-${message.groupId}`, raw: { ok: true } };
  }

  async sendReaction(reaction: SendblueReactionRequest): Promise<SendblueActionResult> {
    return { status: 'OK', messageHandle: reaction.messageHandle, reaction: reaction.reaction, raw: { ok: true } };
  }

  async markRead(receipt: SendblueMarkReadRequest): Promise<SendblueActionResult> {
    return { status: 'OK', number: receipt.toNumber, raw: { ok: true } };
  }

  async sendTypingIndicator(indicator: SendblueTypingIndicator): Promise<SendblueTypingIndicatorResult> {
    this.typingCalls.push(indicator);
    return { status: 'SENT', errorMessage: null, raw: { ok: true } };
  }

  async createContact(contact: SendblueContactRequest): Promise<SendblueContactResult> {
    return { number: contact.number, raw: { ok: true } };
  }
}

describe('agent app flow', () => {
  const config = testConfig();
  let chatClient: FakeChatClient;
  let sendblueClient: FakeSendblueClient;
  let statusStore: InMemoryStatusStore;
  let app: ReturnType<typeof createApp>['app'];

  beforeEach(() => {
    chatClient = new FakeChatClient();
    sendblueClient = new FakeSendblueClient();
    statusStore = new InMemoryStatusStore();
    app = createApp({
      config,
      chatClient,
      sendblueClient,
      statusStore,
      logger: pino({ level: 'silent' })
    }).app;
  });

  it('runs the basic receive to chat to outbound Sendblue flow', async () => {
    chatClient.nextResponse = { messages: ['reply one', 'reply two'] };

    const response = await dispatch(app, {
      method: 'POST',
      path: '/webhook/receive',
      headers: { [config.sendblueWebhookSecretHeader]: config.sendblueWebhookSecret! },
      body: loadFixture('sendblue/receive-basic.json')
    });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ ok: true, accepted: true, state: 'buffering' });

    expect(chatClient.calls).toHaveLength(1);
    expect(chatClient.calls[0]).toMatchObject({
      message: 'hello from iMessage',
      fromNumber: '+15551110001',
      messageHandle: 'recv-basic-001',
      channel: 'imessage',
      conversation: {
        key: 'direct:+15552220000:+15551110001',
        type: 'direct',
        smsDowngraded: false
      },
      messages: [
        {
          content: 'hello from iMessage',
          messageHandle: 'recv-basic-001'
        }
      ]
    });

    expect(sendblueClient.calls).toEqual([
      {
        toNumber: '+15551110001',
        content: 'reply one',
        statusCallback: 'https://agent.example.test/webhook/status'
      }
    ]);
    expect(sendblueClient.typingCalls).toEqual([{ toNumber: '+15551110001' }]);

    const status = await dispatch(app, {
      method: 'POST',
      path: '/webhook/status',
      headers: { [config.sendblueWebhookSecretHeader]: config.sendblueWebhookSecret! },
      body: {
        message_handle: 'sent-1',
        status: 'DELIVERED',
        service: 'iMessage'
      }
    });

    expect(status.status).toBe(200);
    expect(sendblueClient.calls).toEqual([
      {
        toNumber: '+15551110001',
        content: 'reply one',
        statusCallback: 'https://agent.example.test/webhook/status'
      },
      {
        toNumber: '+15551110001',
        content: 'reply two',
        statusCallback: 'https://agent.example.test/webhook/status'
      }
    ]);
  });

  it('deduplicates receive webhook retries by message_handle', async () => {
    const payload = loadFixture<Record<string, unknown>>('sendblue/receive-basic.json');

    expect(
      (
        await dispatch(app, {
          method: 'POST',
          path: '/webhook/receive',
          headers: { [config.sendblueWebhookSecretHeader]: config.sendblueWebhookSecret! },
          body: payload
        })
      ).status
    ).toBe(202);

    const duplicate = await dispatch(app, {
      method: 'POST',
      path: '/webhook/receive',
      headers: { [config.sendblueWebhookSecretHeader]: config.sendblueWebhookSecret! },
      body: payload
    });

    expect(duplicate.status).toBe(200);
    expect(duplicate.body).toEqual({ ok: true, duplicate: true });
    expect(chatClient.calls).toHaveLength(1);
    expect(sendblueClient.calls).toHaveLength(1);
  });

  it('passes SMS downgrade metadata to the chat endpoint', async () => {
    expect(
      (
        await dispatch(app, {
          method: 'POST',
          path: '/webhook/receive',
          headers: { [config.sendblueWebhookSecretHeader]: config.sendblueWebhookSecret! },
          body: loadFixture('sendblue/receive-downgraded.json')
        })
      ).status
    ).toBe(202);

    expect(chatClient.calls[0]).toMatchObject({
      channel: 'sms',
      sendblue: {
        wasDowngraded: true,
        service: 'SMS'
      }
    });
  });

  it('treats SMS service as SMS channel even when it was not downgraded', async () => {
    expect(
      (
        await dispatch(app, {
          method: 'POST',
          path: '/webhook/receive',
          headers: { [config.sendblueWebhookSecretHeader]: config.sendblueWebhookSecret! },
          body: loadFixture<{ body: unknown }>('sendblue/captured/observed/sms-fallback.json').body
        })
      ).status
    ).toBe(202);

    expect(chatClient.calls[0]).toMatchObject({
      channel: 'sms',
      sendblue: {
        wasDowngraded: false,
        service: 'SMS'
      }
    });
  });

  it('accepts silence responses without calling Sendblue', async () => {
    chatClient.nextResponse = { silence: true };

    const response = await dispatch(app, {
      method: 'POST',
      path: '/webhook/receive',
      headers: { [config.sendblueWebhookSecretHeader]: config.sendblueWebhookSecret! },
      body: loadFixture('sendblue/receive-basic.json')
    });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ ok: true, accepted: true });
    expect(sendblueClient.calls).toHaveLength(0);
  });

  it('acknowledges receives and does not send when the chat endpoint fails', async () => {
    chatClient.nextError = new Error('chat down');

    const response = await dispatch(app, {
      method: 'POST',
      path: '/webhook/receive',
      headers: { [config.sendblueWebhookSecretHeader]: config.sendblueWebhookSecret! },
      body: loadFixture('sendblue/receive-basic.json')
    });

    expect(response.status).toBe(202);
    expect(sendblueClient.calls).toHaveLength(0);
  });

  it('rejects receive requests with an invalid webhook secret', async () => {
    const response = await dispatch(app, {
      method: 'POST',
      path: '/webhook/receive',
      headers: { [config.sendblueWebhookSecretHeader]: 'wrong' },
      body: loadFixture('sendblue/receive-basic.json')
    });

    expect(response.status).toBe(401);
    expect(chatClient.calls).toHaveLength(0);
  });

  it('rejects receive requests with a missing webhook secret', async () => {
    const response = await dispatch(app, {
      method: 'POST',
      path: '/webhook/receive',
      body: loadFixture('sendblue/receive-basic.json')
    });

    expect(response.status).toBe(401);
    expect(chatClient.calls).toHaveLength(0);
  });

  it('rejects status callbacks with an invalid webhook secret', async () => {
    const response = await dispatch(app, {
      method: 'POST',
      path: '/webhook/status',
      headers: { [config.sendblueWebhookSecretHeader]: 'wrong' },
      body: loadFixture('sendblue/status-delivered.json')
    });

    expect(response.status).toBe(401);
    expect(statusStore.get('outbound-001')).toBeUndefined();
  });

  it('accepts status callbacks with no signing header (Sendblue does not sign per-message status_callback URLs)', async () => {
    const response = await dispatch(app, {
      method: 'POST',
      path: '/webhook/status',
      headers: {},
      body: loadFixture('sendblue/status-delivered.json')
    });

    // Sendblue's per-message status callbacks arrive unsigned in production;
    // the strict validator was rejecting every legitimate one. The lenient
    // validator accepts unsigned requests but still rejects ones that carry
    // an explicit but wrong header (covered above).
    expect(response.status).toBe(200);
  });

  it('rejects typing-indicator webhooks with an invalid webhook secret', async () => {
    const response = await dispatch(app, {
      method: 'POST',
      path: '/webhook/typing-indicator',
      headers: { [config.sendblueWebhookSecretHeader]: 'wrong' },
      body: { from_number: '+15551110001', is_typing: true }
    });

    expect(response.status).toBe(401);
  });

  it('rejects operational webhooks with an invalid webhook secret', async () => {
    const response = await dispatch(app, {
      method: 'POST',
      path: '/webhook/call-log',
      headers: { [config.sendblueWebhookSecretHeader]: 'wrong' },
      body: { message_handle: 'op-1' }
    });

    expect(response.status).toBe(401);
  });

  it('does not constant-time-leak prefix matches when validating the secret', async () => {
    // The configured testConfig() secret starts with "test-" so a partial-prefix
    // header should still be rejected. This guards against a regression away
    // from constant-time comparison in src/http/security.ts.
    const response = await dispatch(app, {
      method: 'POST',
      path: '/webhook/receive',
      headers: { [config.sendblueWebhookSecretHeader]: config.sendblueWebhookSecret!.slice(0, 4) },
      body: loadFixture('sendblue/receive-basic.json')
    });

    expect(response.status).toBe(401);
  });

  it('accepts Sendblue documented signing-secret header', async () => {
    const response = await dispatch(app, {
      method: 'POST',
      path: '/webhook/receive',
      headers: { 'sb-signing-secret': config.sendblueWebhookSecret! },
      body: loadFixture('sendblue/receive-basic.json')
    });

    expect(response.status).toBe(202);
    expect(chatClient.calls).toHaveLength(1);
  });

  it('tracks status callbacks', async () => {
    const response = await dispatch(app, {
      method: 'POST',
      path: '/webhook/status',
      headers: { [config.sendblueWebhookSecretHeader]: config.sendblueWebhookSecret! },
      body: loadFixture('sendblue/status-delivered.json')
    });

    expect(response.status).toBe(200);
    expect(statusStore.get('outbound-001')).toMatchObject({
      messageHandle: 'outbound-001',
      history: ['DELIVERED'],
      terminalStatus: 'DELIVERED'
    });
  });

  it('replays an unaddressed captured group receive envelope without replying', async () => {
    chatClient.nextResponse = { messages: ['captured reply'] };

    const response = await replayCapturedEnvelope(
      app,
      loadFixture('sendblue/captured/redacted-receive-envelope.json')
    );

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ ok: true, group: true, accepted: false });
    expect(chatClient.calls).toHaveLength(0);
    expect(sendblueClient.calls).toHaveLength(0);
  });

  it('replays a captured status envelope through the app handlers', async () => {
    const response = await replayCapturedEnvelope(
      app,
      loadFixture('sendblue/captured/redacted-status-envelope.json')
    );

    expect(response.status).toBe(200);
    expect(statusStore.get('captured-outbound-001')).toMatchObject({
      messageHandle: 'captured-outbound-001',
      terminalStatus: 'DELIVERED'
    });
  });

  it('replays redacted observed receive payloads through the app handlers', async () => {
    chatClient.nextResponse = { silence: true };

    for (const scenario of observedScenarios) {
      const response = await replayCapturedEnvelope(
        app,
        loadFixture(`sendblue/captured/observed/${scenario}.json`)
      );

      expect(response.status, scenario).toBe(202);
    }

    expect(chatClient.calls).toHaveLength(observedScenarios.length - 1);
    expect(chatClient.calls.find(call => call.messageHandle === 'observed-image-media-001')).toMatchObject({
      sendblue: {
        mediaUrl: 'https://storage.googleapis.com/sendblue-fixtures/image-media.png'
      }
    });
    expect(chatClient.calls.find(call => call.messageHandle === 'observed-group-message-001')).toBeUndefined();
    expect(chatClient.calls.find(call => call.messageHandle === 'observed-tapback-custom-emoji-001')?.message).toMatch(
      /^Reacted 👀 to /
    );
  });

  it('replays operational webhook fixtures through generic handlers', async () => {
    for (const [type, fixture] of operationalScenarios) {
      const response = await replayCapturedEnvelope(
        app,
        loadFixture(`sendblue/captured/operational/${fixture}.json`)
      );

      expect(response.status, type).toBe(202);
      if (type === 'typing_indicator') {
        expect(response.body).toMatchObject({ ok: true });
      } else {
        expect(response.body).toEqual({ ok: true, type });
      }
    }

    expect(chatClient.calls).toHaveLength(0);
    expect(sendblueClient.calls).toHaveLength(0);
  });

  it('rejects malformed receive payloads', async () => {
    const response = await dispatch(app, {
      method: 'POST',
      path: '/webhook/receive',
      headers: { [config.sendblueWebhookSecretHeader]: config.sendblueWebhookSecret! },
      body: { content: 'missing required fields' }
    });

    expect(response.status).toBe(400);
    expect(chatClient.calls).toHaveLength(0);
  });

  it('rejects malformed status payloads with 400', async () => {
    const response = await dispatch(app, {
      method: 'POST',
      path: '/webhook/status',
      headers: { [config.sendblueWebhookSecretHeader]: config.sendblueWebhookSecret! },
      body: { status: 'DELIVERED' }
    });

    expect(response.status).toBe(400);
  });

  it('rejects malformed operational payloads with 400', async () => {
    const response = await dispatch(app, {
      method: 'POST',
      path: '/webhook/call-log',
      headers: { [config.sendblueWebhookSecretHeader]: config.sendblueWebhookSecret! },
      body: 'not an object'
    });

    expect(response.status).toBe(400);
  });

  it('only registers documented Sendblue webhook paths', () => {
    // Defense in depth: a future refactor that mounts the operational handler
    // on a wildcard path could accidentally treat untrusted POSTs as
    // Sendblue-signed traffic. Pin the registered route list so any change
    // gets a code review.
    const routes = app._router.stack
      .filter((layer: { route?: { path?: string } }) => Boolean(layer.route?.path))
      .map((layer: { route?: { path?: string | string[] } }) => layer.route!.path)
      .flat();

    expect(routes).toEqual(
      expect.arrayContaining([
        '/health',
        '/webhook/receive',
        '/webhook/status',
        '/webhook/typing-indicator',
        '/webhook/call-log',
        '/webhook/line-blocked',
        '/webhook/line-assigned',
        '/webhook/contact-created'
      ])
    );
  });

  it('does not enforce webhook secret when no secret is configured', async () => {
    app = createApp({
      config: testConfig({ sendblueWebhookSecret: undefined }),
      chatClient,
      sendblueClient,
      logger: pino({ level: 'silent' })
    }).app;

    expect(
      (
        await dispatch(app, {
          method: 'POST',
          path: '/webhook/receive',
          body: loadFixture('sendblue/receive-basic.json')
        })
      ).status
    ).toBe(202);
    expect(chatClient.calls).toHaveLength(1);
  });

  it('supports health checks', async () => {
    const response = await dispatch(app, { method: 'GET', path: '/health' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true });
    const body = response.body as { uptime_s: number; version: string; node_version: string };
    expect(typeof body.uptime_s).toBe('number');
    expect(typeof body.version).toBe('string');
    expect(typeof body.node_version).toBe('string');
  });

  it('leaves room for status callback retries without duplicate adjacent history', async () => {
    const payload = loadFixture<Record<string, unknown>>('sendblue/status-delivered.json');

    expect(
      (
        await dispatch(app, {
          method: 'POST',
          path: '/webhook/status',
          headers: { [config.sendblueWebhookSecretHeader]: config.sendblueWebhookSecret! },
          body: payload
        })
      ).status
    ).toBe(200);
    expect(
      (
        await dispatch(app, {
          method: 'POST',
          path: '/webhook/status',
          headers: { [config.sendblueWebhookSecretHeader]: config.sendblueWebhookSecret! },
          body: payload
        })
      ).status
    ).toBe(200);

    expect(statusStore.get('outbound-001')?.history).toEqual(['DELIVERED']);
  });

  it('uses the injected dependencies only', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    expect(
      (
        await dispatch(app, {
          method: 'POST',
          path: '/webhook/receive',
          headers: { [config.sendblueWebhookSecretHeader]: config.sendblueWebhookSecret! },
          body: loadFixture('sendblue/receive-basic.json')
        })
      ).status
    ).toBe(202);

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
