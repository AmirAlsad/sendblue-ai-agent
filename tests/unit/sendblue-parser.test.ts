import { describe, expect, it } from 'vitest';
import { parseReceiveWebhook, parseStatusWebhook } from '../../src/sendblue/parser.js';
import { loadFixture } from '../helpers/fixtures.js';

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
    expect(parsed.participants).toEqual(['+15551110002', '+15551110003']);
    expect(parsed.sendStyle).toBe('celebration');
    expect(parsed.raw.undocumented_future_field).toBe('preserved');
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
});
