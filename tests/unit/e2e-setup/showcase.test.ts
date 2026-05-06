import { describe, expect, it } from 'vitest';
import {
  findScenarioId,
  formatShowcasePrompt,
  isSkipContent,
  selectShowcaseScenarios,
  showcaseChatResponse,
  showcaseScenarios,
  showcaseToken,
  summarizeShowcaseStep,
  summarizeUnderstanding
} from '../../../scripts/e2e/lib/showcase.js';
import type { ChatEndpointRequest } from '../../../src/chat/types.js';

type ActionResponse = { actions: Array<Record<string, unknown>> };

function request(overrides: Partial<ChatEndpointRequest> = {}): ChatEndpointRequest {
  return {
    message: '[sendblue-showcase:session-1:basic-text] hello',
    fromNumber: '+15551110001',
    toNumber: '+15552220000',
    messageHandle: 'recv-1',
    channel: 'imessage',
    messages: [
      {
        content: '[sendblue-showcase:session-1:basic-text] hello',
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
    },
    ...overrides
  };
}

describe('Sendblue showcase helpers', () => {
  it('formats conversational scenario prompts without user-visible tokens', () => {
    const scenario = showcaseScenarios.find(item => item.id === 'tapback-heart')!;
    const prompt = formatShowcasePrompt({ scenario, sessionId: 'abc123', index: 3, total: showcaseScenarios.length });

    expect(prompt).toContain('Showcase step 3/13: Heart Tapback understanding.');
    expect(prompt).not.toContain(showcaseToken('abc123', 'tapback-heart'));
    expect(prompt).toContain('Reply "skip" if you want to move past this step.');
  });

  it('selects focused scenario lists and rejects unknown ids', () => {
    expect(selectShowcaseScenarios(['--only', 'basic-text,xml-compat']).map(item => item.id)).toEqual([
      'basic-text',
      'xml-compat'
    ]);

    expect(() => selectShowcaseScenarios(['--only=missing'])).toThrow(/Unknown showcase scenario/);
  });

  it('recognizes skip replies', () => {
    expect(isSkipContent('skip')).toBe(true);
    expect(isSkipContent(' next ')).toBe(true);
    expect(isSkipContent('skip please')).toBe(false);
  });

  it('extracts scenario ids and stripped understanding from buffered messages', () => {
    const chatRequest = request({
      message: '[sendblue-showcase:session-1:burst-buffer] first\n---\n[sendblue-showcase:session-1:burst-buffer] second',
      messages: [
        {
          content: '[sendblue-showcase:session-1:burst-buffer] first',
          fromNumber: '+15551110001',
          toNumber: '+15552220000',
          messageHandle: 'recv-1',
          channel: 'imessage',
          raw: {}
        },
        {
          content: '[sendblue-showcase:session-1:burst-buffer] second',
          fromNumber: '+15551110001',
          toNumber: '+15552220000',
          messageHandle: 'recv-2',
          channel: 'imessage',
          raw: {}
        }
      ]
    });

    expect(findScenarioId(chatRequest)).toBe('burst-buffer');
    expect(summarizeUnderstanding(chatRequest)).toBe('first | second');
  });

  it('builds capability-specific chat responses', () => {
    const textResponse = showcaseChatResponse(request()) as ActionResponse;
    expect(textResponse.actions[0]).toMatchObject({
      type: 'message',
      content: 'Text understood: hello'
    });

    const tapbackResponse = showcaseChatResponse(
      request({
        message: 'Loved "[sendblue-showcase:session-1:tapback-heart] prompt"',
        messages: [
          {
            content: 'Loved "[sendblue-showcase:session-1:tapback-heart] prompt"',
            fromNumber: '+15551110001',
            toNumber: '+15552220000',
            messageHandle: 'tapback-1',
            channel: 'imessage',
            raw: {}
          }
        ]
      })
    ) as ActionResponse;
    expect(tapbackResponse.actions[0]).toMatchObject({
      type: 'message',
      content: 'Tapback understood: Loved " prompt"'
    });

    const mediaResponse = showcaseChatResponse(
      request({
        message: '[sendblue-showcase:session-1:outbound-media] outbound media',
        messages: [
          {
            content: '[sendblue-showcase:session-1:outbound-media] outbound media',
            fromNumber: '+15551110001',
            toNumber: '+15552220000',
            messageHandle: 'media-1',
            channel: 'imessage',
            raw: {}
          }
        ]
      }),
      { mediaUrl: 'https://cdn.example.test/showcase.png' }
    ) as ActionResponse;
    expect(mediaResponse.actions).toEqual([
      { type: 'message', content: 'Outbound media request understood: outbound media' },
      {
        type: 'media',
        content: 'Hosted media from the showcase endpoint.',
        mediaUrl: 'https://cdn.example.test/showcase.png'
      }
    ]);
  });

  it('can route token-free showcase requests by the active scenario', () => {
    const response = showcaseChatResponse(
      request({
        message: 'xml please',
        messages: [
          {
            content: 'xml please',
            fromNumber: '+15551110001',
            toNumber: '+15552220000',
            messageHandle: 'xml-1',
            channel: 'imessage',
            raw: {}
          }
        ]
      }),
      {},
      'xml-compat'
    ) as { message: string };

    expect(response.message).toContain('<message send_style="balloons">XML compatibility demo:');
    expect(response.message).toContain('xml please');
  });

  it('summarizes per-step webhook and Sendblue call evidence', () => {
    const scenario = showcaseScenarios.find(item => item.id === 'read-typing')!;
    const summary = summarizeShowcaseStep({
      scenario,
      skipped: false,
      matched: true,
      envelopes: [
        {
          sequence: 1,
          headers: {},
          body: { content: '[sendblue-showcase:s:read-typing] read typing' },
          rawBody: '{}',
          receivedAt: '2026-05-06T12:00:00.000Z',
          path: '/webhook/receive',
          capture: { scenarioId: 'read-typing' }
        },
        {
          sequence: 2,
          headers: {},
          body: { status: 'DELIVERED' },
          rawBody: '{}',
          receivedAt: '2026-05-06T12:00:01.000Z',
          path: '/webhook/status',
          capture: { scenarioId: 'read-typing' }
        }
      ],
      calls: [
        { kind: 'read-receipt', at: '2026-05-06T12:00:00.000Z', payload: {} },
        { kind: 'typing-indicator', at: '2026-05-06T12:00:00.000Z', payload: {} },
        { kind: 'message', at: '2026-05-06T12:00:02.000Z', payload: {} }
      ]
    });

    expect(summary).toMatchObject({
      scenarioId: 'read-typing',
      matched: true,
      receiveCount: 1,
      statusCount: 1,
      readReceiptCount: 1,
      typingCount: 1,
      typingSucceededCount: 0,
      typingFailedCount: 0,
      inboundTypingWebhookCount: 0,
      chatRequestCount: 0,
      maxBufferedMessageCount: 0,
      messageCount: 1,
      understood: 'read typing'
    });
  });
});
