import { describe, expect, it } from 'vitest';
import { normalizeChatResponse } from '../../src/chat/client.js';
import { createChatRequest } from '../../src/chat/types.js';
import { parseReceiveWebhook } from '../../src/sendblue/parser.js';
import { loadFixture } from '../helpers/fixtures.js';

describe('chat endpoint contract', () => {
  it('normalizes single-message, multi-message, and silence responses', () => {
    expect(normalizeChatResponse({ message: 'hello' })).toEqual({ messages: ['hello'] });
    expect(normalizeChatResponse({ messages: ['one', '', 'two'] })).toEqual({
      messages: ['one', 'two']
    });
    expect(normalizeChatResponse({ silence: true })).toEqual({ silence: true });
  });

  it('rejects malformed chat responses', () => {
    expect(() => normalizeChatResponse({ ok: true })).toThrow(/message, messages, or silence/);
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
});
