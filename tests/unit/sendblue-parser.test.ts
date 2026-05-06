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

  it('rejects non-object receive payloads', () => {
    expect(() => parseReceiveWebhook(null)).toThrow(/must be an object/);
    expect(() => parseReceiveWebhook('not-an-object')).toThrow(/must be an object/);
    expect(() => parseReceiveWebhook([{ content: 'arr' }])).toThrow(/must be an object/);
  });

  it('rejects empty required identifiers but allows empty content (media-only)', () => {
    // Required identifiers must be non-empty.
    expect(() =>
      parseReceiveWebhook({
        content: '',
        from_number: '',
        to_number: '+15552220000',
        message_handle: 'h-1'
      })
    ).toThrow(/from_number/);

    // Empty content is legal (e.g. media-only inbound, observed tapback echoes).
    const parsed = parseReceiveWebhook({
      content: '',
      from_number: '+15551110001',
      to_number: '+15552220000',
      message_handle: 'recv-empty-content-001',
      media_url: 'https://cdn.example.test/audio.m4a',
      service: 'iMessage'
    });
    expect(parsed.content).toBe('');
    expect(parsed.mediaUrl).toBe('https://cdn.example.test/audio.m4a');
  });

  it('surfaces documented Sendblue envelope metadata for receive webhooks', () => {
    const parsed = parseReceiveWebhook(
      loadFixture<{ body: unknown }>('sendblue/captured/observed/basic-text.json').body
    );
    expect(parsed.accountEmail).toBe('agent@example.test');
    expect(parsed.plan).toBe('dedicated');
    expect(parsed.optedOut).toBe(false);
    expect(parsed.number).toBe('+15550000001');
    expect(parsed.dateSent).toBe('2026-05-06T04:00:00.000Z');
    expect(parsed.dateUpdated).toBe('2026-05-06T04:00:00.000Z');
    expect(parsed.errorCode).toBeUndefined();
    expect(parsed.errorMessage).toBeUndefined();
    expect(parsed.errorDetail).toBeUndefined();
    expect(parsed.errorReason).toBeUndefined();
  });

  it('preserves null group_display_name distinctly from empty string', () => {
    const withNullName = parseReceiveWebhook({
      content: 'hi',
      from_number: '+15551110001',
      to_number: '+15552220000',
      message_handle: 'recv-null-display-001',
      group_display_name: null
    });
    expect(withNullName.groupDisplayName).toBeNull();

    const withEmptyName = parseReceiveWebhook({
      content: 'hi',
      from_number: '+15551110001',
      to_number: '+15552220000',
      message_handle: 'recv-empty-display-001',
      group_display_name: ''
    });
    expect(withEmptyName.groupDisplayName).toBe('');
  });

  it('captures media-only inbound payload shape with empty content', () => {
    const parsed = parseReceiveWebhook({
      accountEmail: 'agent@example.test',
      content: '',
      is_outbound: false,
      status: 'RECEIVED',
      message_handle: 'recv-media-only-001',
      from_number: '+15551110001',
      number: '+15551110001',
      to_number: '+15552220000',
      was_downgraded: null,
      media_url: 'https://cdn.example.test/photo.png',
      message_type: 'message',
      group_id: '',
      participants: [],
      send_style: '',
      service: 'iMessage'
    });
    expect(parsed.content).toBe('');
    expect(parsed.mediaUrl).toBe('https://cdn.example.test/photo.png');
    expect(parsed.status).toBe('RECEIVED');
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

  it('rejects status callbacks missing message_handle', () => {
    expect(() =>
      parseStatusWebhook({
        status: 'DELIVERED'
      })
    ).toThrow(/message_handle/);
  });

  it('rejects non-object status payloads', () => {
    expect(() => parseStatusWebhook(null)).toThrow(/must be an object/);
    expect(() => parseStatusWebhook(42)).toThrow(/must be an object/);
  });

  it('parses every documented status value (REGISTERED through ERROR)', () => {
    const documented = [
      'REGISTERED',
      'PENDING',
      'DECLINED',
      'QUEUED',
      'ACCEPTED',
      'SENT',
      'DELIVERED',
      'ERROR'
    ] as const;
    for (const status of documented) {
      const parsed = parseStatusWebhook({ message_handle: `out-${status}`, status });
      expect(parsed.status, status).toBe(status);
    }
  });

  it('preserves status-callback envelope metadata and SMS service marker', () => {
    const parsed = parseStatusWebhook(loadFixture('sendblue/status-error.json'));
    expect(parsed.fromNumber).toBe('+15552220000');
    expect(parsed.toNumber).toBe('+15551110001');
    expect(parsed.errorDetail).toBe(
      'Reduce send frequency or wait for the current window to reset'
    );
    expect(parsed.service).toBe('SMS');
    expect(parsed.wasDowngraded).toBe(true);
  });

  it('parses error_reason when Sendblue includes one', () => {
    const parsed = parseStatusWebhook({
      message_handle: 'outbound-reasoned-001',
      status: 'ERROR',
      error_code: '4001',
      error_message: 'Rate limit exceeded',
      error_reason: 'Too many sends in window'
    });
    expect(parsed.errorReason).toBe('Too many sends in window');
    expect(parsed.errorCode).toBe('4001');
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

  it('rejects typing indicator payloads missing required identifiers', () => {
    expect(() =>
      parseTypingIndicatorWebhook({
        from_number: '+15552220000',
        is_typing: false
      })
    ).toThrow(/number/);
    expect(() =>
      parseTypingIndicatorWebhook({
        number: '+15551110001',
        is_typing: false
      })
    ).toThrow(/from_number/);
    expect(() => parseTypingIndicatorWebhook(null)).toThrow(/must be an object/);
  });

  it('treats non-boolean is_typing as false', () => {
    const parsed = parseTypingIndicatorWebhook({
      number: '+15551110001',
      from_number: '+15552220000'
    });
    expect(parsed.isTyping).toBe(false);
  });

  it('preserves call_log event_type and metadata on operational webhooks', () => {
    const parsed = parseOperationalWebhook({
      event_type: 'call_log',
      call_id: 'call-001',
      from_number: '+15551110001',
      to_number: '+15552220000',
      direction: 'inbound',
      status: 'completed',
      duration: 42,
      provider: 'twilio',
      transcript: 'hello'
    });
    expect(parsed.eventType).toBe('call_log');
    expect(parsed.fromNumber).toBe('+15551110001');
    expect(parsed.toNumber).toBe('+15552220000');
    expect(parsed.status).toBe('completed');
    expect(parsed.raw.call_id).toBe('call-001');
    expect(parsed.raw.duration).toBe(42);
  });

  it('rejects non-object operational payloads', () => {
    expect(() => parseOperationalWebhook(null)).toThrow(/must be an object/);
    expect(() => parseOperationalWebhook('not-an-object')).toThrow(/must be an object/);
  });
});
