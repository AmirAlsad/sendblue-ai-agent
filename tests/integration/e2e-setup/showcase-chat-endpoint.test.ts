import { describe, expect, it } from 'vitest';
import { createShowcaseChatApp } from '../../../scripts/e2e/lib/showcase.js';
import type { ChatEndpointRequest } from '../../../src/chat/types.js';
import { dispatch } from '../../helpers/dispatch.js';

function request(message: string): ChatEndpointRequest {
  return {
    message,
    fromNumber: '+15551110001',
    toNumber: '+15552220000',
    messageHandle: 'recv-1',
    channel: 'imessage',
    messages: [
      {
        content: message,
        fromNumber: '+15551110001',
        toNumber: '+15552220000',
        messageHandle: 'recv-1',
        channel: 'imessage',
        raw: {}
      }
    ],
    conversation: {
      key: 'direct:+15552220000:+15551110001',
      type: 'direct',
      lineNumber: '+15552220000',
      phoneNumber: '+15551110001',
      channel: 'imessage',
      smsDowngraded: false,
      state: 'processing'
    },
    typing: null,
    sendblue: {
      wasDowngraded: false,
      service: 'iMessage',
      mediaUrl: null,
      raw: {}
    }
  };
}

describe('showcase chat endpoint', () => {
  it('serves scenario-aware JSON actions', async () => {
    const app = createShowcaseChatApp({
      mediaUrl: 'https://cdn.example.test/showcase.png',
      readTypingDelayMs: 0
    });

    const response = await dispatch(app, {
      method: 'POST',
      path: '/chat',
      body: request('[sendblue-showcase:s:outbound-media] outbound media')
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      actions: [
        { type: 'message', content: 'Outbound media request understood: outbound media' },
        { type: 'media', mediaUrl: 'https://cdn.example.test/showcase.png' }
      ]
    });
  });

  it('serves XML compatibility through the legacy message field', async () => {
    const app = createShowcaseChatApp({ readTypingDelayMs: 0, currentScenarioId: () => 'xml-compat' });

    const response = await dispatch(app, {
      method: 'POST',
      path: '/chat',
      body: request('xml please')
    });

    expect(response.status).toBe(200);
    const body = response.body as { message: string };
    expect(body.message).toContain('<message send_style="balloons">XML compatibility demo:');
    expect(body.message).toContain('I understood: xml please.');
    expect(body.message).not.toContain('<reply');
  });

  it('echoes addressed group and SMS fallback context', async () => {
    const app = createShowcaseChatApp({ agentDisplayName: 'sb-agent', readTypingDelayMs: 0 });

    const groupRequest = {
      ...request('@sb-agent [sendblue-showcase:s:addressed-group] hello group'),
      conversation: {
        key: 'group:+15552220000:group-1',
        type: 'group',
        lineNumber: '+15552220000',
        groupId: 'group-1',
        channel: 'imessage',
        smsDowngraded: false,
        state: 'processing'
      },
      sendblue: {
        wasDowngraded: false,
        service: 'iMessage',
        groupId: 'group-1',
        mediaUrl: null,
        raw: {}
      }
    };
    const smsRequest = {
      ...request('[sendblue-showcase:s:sms-fallback] sms hello'),
      channel: 'sms',
      conversation: {
        key: 'direct:+15552220000:+15551110001',
        type: 'direct',
        lineNumber: '+15552220000',
        phoneNumber: '+15551110001',
        channel: 'sms',
        smsDowngraded: true,
        state: 'processing'
      },
      sendblue: {
        wasDowngraded: true,
        service: 'SMS',
        mediaUrl: null,
        raw: {}
      }
    };

    const groupResponse = await dispatch(app, {
      method: 'POST',
      path: '/chat',
      body: groupRequest
    });
    const smsResponse = await dispatch(app, {
      method: 'POST',
      path: '/chat',
      body: smsRequest
    });

    expect(groupResponse.body).toMatchObject({
      actions: [{ content: 'Addressed group understood by sb-agent: @sb-agent hello group' }]
    });
    expect(smsResponse.body).toMatchObject({
      actions: [{ content: 'SMS fallback understood and rich iMessage-only actions are suppressed: sms hello' }]
    });
  });
});
