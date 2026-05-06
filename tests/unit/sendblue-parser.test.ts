import { describe, expect, it } from 'vitest';
import {
  parseOperationalWebhook,
  parseReceiveWebhook,
  parseStatusWebhook,
  parseTypingIndicatorWebhook
} from '../../src/sendblue/parser.js';
import { loadFixture } from '../helpers/fixtures.js';

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

describe('Sendblue webhook parsing', () => {
  it('parses a basic receive webhook', () => {
    const parsed = parseReceiveWebhook(loadFixture('sendblue/receive-basic.json'));

    expect(parsed).toMatchObject({
      content: 'hello from iMessage',
      fromNumber: '+15551110001',
      toNumber: '+15552220000',
      messageHandle: 'recv-basic-001',
      isOutbound: false,
      status: 'REGISTERED',
      wasDowngraded: null,
      service: 'iMessage'
    });
  });

  it('preserves media, group, send style, participants, and unknown raw fields', () => {
    const parsed = parseReceiveWebhook(loadFixture('sendblue/receive-media-group.json'));

    expect(parsed.mediaUrl).toBe('https://cdn.example.test/photo.png');
    expect(parsed.groupId).toBe('group-123');
    expect(parsed.groupDisplayName).toBeNull();
    expect(parsed.participants).toEqual(['+15551110002', '+15551110003']);
    expect(parsed.sendStyle).toBe('celebration');
    expect(parsed.raw.undocumented_future_field).toBe('preserved');
  });

  it('parses every redacted observed receive envelope', () => {
    for (const scenario of observedScenarios) {
      const envelope = loadFixture<{ body: unknown }>(`sendblue/captured/observed/${scenario}.json`);
      const parsed = parseReceiveWebhook(envelope.body);

      expect(parsed.status, scenario).toBe('RECEIVED');
      expect(parsed.messageHandle, scenario).toBe(`observed-${scenario}-001`);
      expect(parsed.raw, scenario).toHaveProperty('accountEmail', 'agent@example.test');
    }
  });

  it('captures observed media payload shape', () => {
    for (const scenario of ['image-media', 'video-media', 'audio-or-file-media']) {
      const envelope = loadFixture<{ body: unknown }>(`sendblue/captured/observed/${scenario}.json`);
      const parsed = parseReceiveWebhook(envelope.body);

      expect(parsed.messageType, scenario).toBe('message');
      expect(parsed.service, scenario).toBe('iMessage');
      expect(parsed.mediaUrl, scenario).toMatch(/^https:\/\/storage\.googleapis\.com\/sendblue-fixtures\//);
      expect(parsed.sendStyle, scenario).toBe('');
    }
  });

  it('captures observed tapback payload shape as message content', () => {
    const expectedContent = {
      'tapback-heart': /^Loved /,
      'tapback-thumbs-up': /^Liked /,
      'tapback-thumbs-down': /^Disliked /,
      'tapback-haha': /^Laughed at /,
      'tapback-emphasis': /^Emphasized /,
      'tapback-question': /^Questioned /,
      'tapback-custom-emoji': /^Reacted 👀 to /
    } as const;

    for (const [scenario, contentPattern] of Object.entries(expectedContent)) {
      const envelope = loadFixture<{ body: unknown }>(`sendblue/captured/observed/${scenario}.json`);
      const parsed = parseReceiveWebhook(envelope.body);

      expect(parsed.messageType, scenario).toBe('message');
      expect(parsed.content, scenario).toMatch(contentPattern);
      expect(parsed.raw, scenario).not.toHaveProperty('reaction_type');
      expect(parsed.raw, scenario).not.toHaveProperty('referenced_message_handle');
    }
  });

  it('captures observed inbound send effects as plain messages without send_style', () => {
    for (const scenario of ['effect-balloons', 'effect-celebration']) {
      const envelope = loadFixture<{ body: unknown }>(`sendblue/captured/observed/${scenario}.json`);
      const parsed = parseReceiveWebhook(envelope.body);

      expect(parsed.messageType, scenario).toBe('message');
      expect(parsed.sendStyle, scenario).toBe('');
      expect(parsed.mediaUrl, scenario).toBe('');
    }
  });

  it('captures observed group and SMS-originated payload shapes', () => {
    const group = parseReceiveWebhook(
      loadFixture<{ body: unknown }>('sendblue/captured/observed/group-message.json').body
    );
    expect(group.messageType).toBe('group');
    expect(group.groupId).toBe('observed-group-001');
    expect(group.groupDisplayName).toBe('');
    expect(group.participants).toHaveLength(4);

    const sms = parseReceiveWebhook(
      loadFixture<{ body: unknown }>('sendblue/captured/observed/sms-fallback.json').body
    );
    expect(sms.service).toBe('SMS');
    expect(sms.wasDowngraded).toBeNull();
  });

  it('parses SMS downgrade state as conversation metadata', () => {
    const parsed = parseReceiveWebhook(loadFixture('sendblue/receive-downgraded.json'));

    expect(parsed.wasDowngraded).toBe(true);
    expect(parsed.service).toBe('SMS');
  });

  it('rejects missing required receive fields', () => {
    expect(() => parseReceiveWebhook({ content: 'no handle' })).toThrow(/from_number/);
  });

  it('parses delivered and error status callbacks', () => {
    expect(parseStatusWebhook(loadFixture('sendblue/status-delivered.json'))).toMatchObject({
      messageHandle: 'outbound-001',
      status: 'DELIVERED'
    });

    expect(parseStatusWebhook(loadFixture('sendblue/status-error.json'))).toMatchObject({
      messageHandle: 'outbound-error-001',
      status: 'ERROR',
      errorCode: '5509',
      errorMessage: 'Rate limit window exceeded'
    });
  });

  it('does not accept READ as a formal status', () => {
    expect(() =>
      parseStatusWebhook({
        message_handle: 'outbound-read-001',
        status: 'READ'
      })
    ).toThrow(/invalid Sendblue status/);
  });

  it('does not accept RECEIVED as a status callback status', () => {
    expect(() =>
      parseStatusWebhook({
        message_handle: 'outbound-received-001',
        status: 'RECEIVED'
      })
    ).toThrow(/invalid Sendblue status/);
  });

  it('preserves generic operational webhook payloads for future handlers', () => {
    expect(
      parseOperationalWebhook({
        message_handle: 'typing-001',
        from_number: '+15551110001',
        to_number: '+15552220000',
        status: 'started',
        unknown_field: { nested: true }
      })
    ).toMatchObject({
      messageHandle: 'typing-001',
      fromNumber: '+15551110001',
      toNumber: '+15552220000',
      status: 'started',
      raw: {
        unknown_field: { nested: true }
      }
    });
  });

  it('parses typing indicator webhook payloads', () => {
    expect(
      parseTypingIndicatorWebhook({
        number: '+15551110001',
        from_number: '+15552220000',
        is_typing: true,
        timestamp: '2026-05-06T12:00:00.000Z'
      })
    ).toMatchObject({
      number: '+15551110001',
      fromNumber: '+15552220000',
      isTyping: true,
      timestamp: '2026-05-06T12:00:00.000Z'
    });
  });
});
