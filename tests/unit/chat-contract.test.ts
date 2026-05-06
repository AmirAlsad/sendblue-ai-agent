import { describe, expect, it } from 'vitest';
import { normalizeChatResponse, parseTaggedText } from '../../src/chat/client.js';
import { SENDBLUE_REACTIONS, SENDBLUE_SEND_STYLES } from '../../src/sendblue/types.js';

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

  it('passes through every documented Sendblue send_style on message actions', () => {
    for (const sendStyle of SENDBLUE_SEND_STYLES) {
      expect(
        normalizeChatResponse({ actions: [{ type: 'message', content: 'hi', sendStyle }] })
      ).toEqual({ actions: [{ type: 'message', content: 'hi', sendStyle }] });
    }
  });

  it('drops unknown send_style values without dropping the action', () => {
    const response = normalizeChatResponse({
      actions: [{ type: 'message', content: 'hi', sendStyle: 'tornado' }]
    });
    expect(response.actions).toEqual([{ type: 'message', content: 'hi' }]);
  });

  it('accepts every documented Sendblue reaction value', () => {
    for (const reaction of SENDBLUE_REACTIONS) {
      const response = normalizeChatResponse({
        actions: [{ type: 'reaction', reaction, target: { messageHandle: 'recv-1' } }]
      });
      expect(response.actions).toEqual([
        { type: 'reaction', reaction, target: { messageHandle: 'recv-1' } }
      ]);
    }
  });

  it('aliases legacy reaction names (heart, haha) onto canonical Sendblue values', () => {
    const heart = normalizeChatResponse({
      actions: [{ type: 'reaction', reaction: 'heart', target: { messageHandle: 'recv-1' } }]
    });
    expect(heart.actions).toEqual([
      { type: 'reaction', reaction: 'love', target: { messageHandle: 'recv-1' } }
    ]);

    const haha = normalizeChatResponse({
      actions: [{ type: 'reaction', reaction: 'haha', target: { messageHandle: 'recv-1' } }]
    });
    expect(haha.actions).toEqual([
      { type: 'reaction', reaction: 'laugh', target: { messageHandle: 'recv-1' } }
    ]);
  });

  it('round-trips media actions with optional caption and sendStyle', () => {
    expect(
      normalizeChatResponse({
        actions: [
          {
            type: 'media',
            mediaUrl: 'https://cdn.example.com/photo.png',
            content: 'caption',
            sendStyle: 'celebration'
          }
        ]
      })
    ).toEqual({
      actions: [
        {
          type: 'media',
          mediaUrl: 'https://cdn.example.com/photo.png',
          content: 'caption',
          sendStyle: 'celebration'
        }
      ]
    });
  });

  it('rejects media actions without a mediaUrl', () => {
    const response = normalizeChatResponse({ actions: [{ type: 'media', content: 'no url' }] });
    expect(response.actions).toEqual([]);
    expect(response.warnings?.[0].code).toBe('invalid-media-action');
  });

  it('preserves snake_case media_url and send_style inputs', () => {
    expect(
      normalizeChatResponse({
        actions: [
          {
            type: 'message',
            content: 'hi',
            media_url: 'https://cdn.example.com/photo.png',
            send_style: 'balloons'
          }
        ]
      })
    ).toEqual({
      actions: [
        {
          type: 'message',
          content: 'hi',
          mediaUrl: 'https://cdn.example.com/photo.png',
          sendStyle: 'balloons'
        }
      ]
    });
  });

  it('treats an empty actions[] array as a recognized non-silent no-op', () => {
    expect(normalizeChatResponse({ actions: [] })).toEqual({ actions: [] });
  });

  it('drops the entire response when an action-level silence is mixed with outbound actions', () => {
    const response = normalizeChatResponse({
      actions: [
        { type: 'message', content: 'send' },
        { type: 'silence' }
      ]
    });
    expect(response.actions).toEqual([]);
    expect(response.warnings?.[0].code).toBe('mixed-silence-actions');
  });

  it('treats a sole silence action as silence without outbound', () => {
    expect(normalizeChatResponse({ actions: [{ type: 'silence' }] })).toEqual({
      actions: [],
      silence: true
    });
  });

  it('parses tagged media on message actions and exposes the underlying mediaUrl', () => {
    expect(
      normalizeChatResponse({
        message:
          '<message media_url="https://cdn.example.com/a.png">caption</message>'
      })
    ).toEqual({
      actions: [
        { type: 'message', content: 'caption', mediaUrl: 'https://cdn.example.com/a.png' }
      ]
    });
  });

  it('preserves nested message tag inside reply tag for content and mediaUrl', () => {
    expect(
      normalizeChatResponse({
        message:
          '<reply target="last"><message media_url="https://cdn.example.com/a.png">replying</message></reply>'
      })
    ).toEqual({
      actions: [
        {
          type: 'reply',
          content: 'replying',
          mediaUrl: 'https://cdn.example.com/a.png',
          target: { alias: 'last' }
        }
      ]
    });
  });

  it('throws when payload is not an object (string, array, null)', () => {
    expect(() => normalizeChatResponse('hi')).toThrow(/must be an object/);
    expect(() => normalizeChatResponse([])).toThrow(/must be an object/);
    expect(() => normalizeChatResponse(null)).toThrow(/must be an object/);
  });
});
