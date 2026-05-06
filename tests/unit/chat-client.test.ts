import { describe, expect, it } from 'vitest';
import { normalizeChatResponse } from '../../src/chat/client.js';
import { createChatRequest } from '../../src/chat/types.js';
import { parseReceiveWebhook } from '../../src/sendblue/parser.js';
import { loadFixture } from '../helpers/fixtures.js';

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
