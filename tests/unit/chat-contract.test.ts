import { describe, expect, it } from 'vitest';
import { normalizeChatResponse, parseTaggedText } from '../../src/chat/client.js';

describe('hybrid chat response contract', () => {
  it('parses default response tags into ordered actions', () => {
    expect(
      normalizeChatResponse({
        message:
          '<message send_style="celebration">first</message><reply target="previous">second</reply><reaction type="like" target="last" />'
      })
    ).toEqual({
      actions: [
        { type: 'message', content: 'first', sendStyle: 'celebration' },
        { type: 'reply', content: 'second', target: { alias: 'previous' } },
        { type: 'reaction', reaction: 'like', target: { alias: 'last' } }
      ]
    });
  });

  it('supports configurable tag names', () => {
    expect(
      normalizeChatResponse(
        {
          message: '<say>hello</say><tapback reaction="love" message_handle="recv-1" />'
        },
        {
          tags: {
            message: 'say',
            noResponse: 'nothing',
            reaction: 'tapback',
            reply: 'thread'
          }
        }
      )
    ).toEqual({
      actions: [
        { type: 'message', content: 'hello' },
        { type: 'reaction', reaction: 'love', target: { messageHandle: 'recv-1' } }
      ]
    });
  });

  it('preserves untagged legacy responses as message actions', () => {
    expect(normalizeChatResponse({ message: 'single reply' })).toEqual({
      actions: [{ type: 'message', content: 'single reply' }]
    });
    expect(normalizeChatResponse({ messages: ['first', '', 'second'] })).toEqual({
      actions: [
        { type: 'message', content: 'first' },
        { type: 'message', content: 'second' }
      ]
    });
  });

  it('normalizes structured actions and defaults reaction targets to the latest inbound message', () => {
    expect(
      normalizeChatResponse({
        actions: [
          { type: 'message', content: 'plain' },
          { type: 'reply', message: 'threaded', target: { content: 'question', partIndex: 0 } },
          { type: 'reaction', reaction: 'emphasize' }
        ]
      })
    ).toEqual({
      actions: [
        { type: 'message', content: 'plain' },
        { type: 'reply', content: 'threaded', target: { content: 'question', partIndex: 0 } },
        { type: 'reaction', reaction: 'emphasize', target: { alias: 'last' } }
      ]
    });
  });

  it('treats no-response tags and silence actions as exclusive', () => {
    expect(normalizeChatResponse({ message: '<no_response />' })).toEqual({
      silence: true,
      actions: []
    });

    const mixedTopLevel = normalizeChatResponse({ silence: true, message: 'do not send this' });
    expect(mixedTopLevel.actions).toEqual([]);
    expect(mixedTopLevel.warnings?.[0].code).toBe('mixed-silence-actions');

    const mixedTags = normalizeChatResponse({ message: '<no_response /><message>do not send this</message>' });
    expect(mixedTags.actions).toEqual([]);
    expect(mixedTags.warnings?.[0].code).toBe('mixed-silence-actions');
  });

  it('returns warning-bearing empty actions for invalid action payloads', () => {
    const response = normalizeChatResponse({
      actions: [{ type: 'message' }, { type: 'reaction' }, { type: 'unknown', message: 'ignored' }]
    });

    expect(response.actions).toEqual([]);
    expect(response.warnings?.map(item => item.code)).toEqual([
      'invalid-message-action',
      'invalid-reaction-action',
      'unknown-action-type'
    ]);
  });

  it('rejects payloads without any supported contract field', () => {
    expect(() => normalizeChatResponse(null)).toThrow(/must be an object/);
    expect(() => normalizeChatResponse({ ok: true })).toThrow(/message, messages, actions, or silence/);
  });

  it('can leave tag-like text untouched when tag parsing is disabled', () => {
    expect(normalizeChatResponse({ message: '<message>literal</message>' }, { parseTags: false })).toEqual({
      actions: [{ type: 'message', content: '<message>literal</message>' }]
    });
  });

  it('exposes a focused tag parser for direct parser tests', () => {
    expect(parseTaggedText('before <reaction>question</reaction> after').actions).toEqual([
      { type: 'message', content: 'before' },
      { type: 'reaction', reaction: 'question', target: { alias: 'last' } },
      { type: 'message', content: 'after' }
    ]);
  });
});
