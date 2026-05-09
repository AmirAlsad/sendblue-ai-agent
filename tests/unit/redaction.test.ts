import { describe, expect, it } from 'vitest';
import {
  redactConversationRecord,
  redactContent,
  redactPhone,
  redactStatusRecord
} from '../../src/http/redaction.js';
import { createIdleConversation } from '../../src/conversation/types.js';
import { applyStatusUpdate } from '../../src/status/tracker.js';

describe('redactPhone', () => {
  it('preserves leading + and trailing 4 digits', () => {
    expect(redactPhone('+15551234567')).toBe('+*******4567');
  });

  it('returns empty string for nullish input', () => {
    expect(redactPhone(undefined)).toBe('');
    expect(redactPhone(null)).toBe('');
    expect(redactPhone('')).toBe('');
  });

  it('is idempotent on already-redacted values', () => {
    const once = redactPhone('+15551234567');
    expect(redactPhone(once)).toBe(once);
  });

  it('handles short numbers', () => {
    expect(redactPhone('1234')).toBe('****');
    expect(redactPhone('+1234')).toBe('+****');
  });
});

describe('redactContent', () => {
  it('replaces content with length sentinel', () => {
    expect(redactContent('hello there')).toBe('[redacted len=11]');
  });

  it('is idempotent', () => {
    const r = redactContent('abc');
    expect(redactContent(r)).toBe(r);
  });

  it('returns empty string for nullish input', () => {
    expect(redactContent(undefined)).toBe('');
    expect(redactContent(null)).toBe('');
  });
});

describe('redactConversationRecord', () => {
  it('redacts phone numbers, content, key, and identity names', () => {
    const record = createIdleConversation({
      key: 'direct:+15552220000:+15551234567',
      lineNumber: '+15552220000',
      phoneNumber: '+15551234567',
      identity: { userId: 'u1', firstName: 'Amelia', lastName: 'Park' }
    });
    record.inboundBuffer.push({
      content: 'hello',
      fromNumber: '+15551234567',
      toNumber: '+15552220000',
      messageHandle: 'm1',
      receivedAt: '2026-05-08T00:00:00.000Z',
      wasDowngraded: false,
      service: 'iMessage',
      channel: 'imessage',
      raw: {}
    });
    record.deliveredMessages.push('hi friend');

    const redacted = redactConversationRecord(record);
    expect(redacted.lineNumber).toBe('+*******0000');
    expect(redacted.phoneNumber).toBe('+*******4567');
    expect(redacted.key).toBe('direct:+*******0000:+*******4567');
    expect(redacted.inboundBuffer[0].content).toBe('[redacted len=5]');
    expect(redacted.inboundBuffer[0].fromNumber).toBe('+*******4567');
    expect(redacted.deliveredMessages[0]).toBe('[redacted len=9]');
    expect(redacted.identity?.firstName).toBe('A***');
    expect(redacted.identity?.lastName).toBe('P***');
  });

  it('redacts identity.userId, data, tags, and customVariables', () => {
    const record = createIdleConversation({
      key: 'direct:+15552220000:+15551234567',
      lineNumber: '+15552220000',
      phoneNumber: '+15551234567',
      identity: {
        userId: '+15551234567',
        data: { ssn: '123-45-6789', email: 'amelia@example.com' },
        tags: ['agent-line:+15552220000', 'tier:gold'],
        customVariables: { city: 'Brooklyn', dob: '1990-01-01' }
      }
    });

    const redacted = redactConversationRecord(record);
    expect(redacted.identity?.userId).toBe('[redacted len=12]');
    expect(redacted.identity?.data).toBe('[redacted]');
    expect(redacted.identity?.tags).toEqual(['[redacted len=23]', '[redacted len=9]']);
    expect(redacted.identity?.customVariables).toEqual({
      city: '[redacted len=8]',
      dob: '[redacted len=10]'
    });
  });

  it('redacts groupDisplayName as a name and outbound replyTo / mediaUrl as content', () => {
    const record = createIdleConversation({
      key: 'group:+15552220000:abc',
      type: 'group',
      lineNumber: '+15552220000',
      phoneNumber: '+15551234567',
      groupId: 'abc',
      groupDisplayName: 'Pizza Party'
    });
    record.outboundQueue.push({
      id: 'out-1',
      kind: 'reply',
      content: 'sure thing',
      replyTo: 'inbound-message-handle-001',
      mediaUrl: 'https://cdn.example.com/+15551234567/secret.jpg'
    });

    const redacted = redactConversationRecord(record);
    expect(redacted.groupDisplayName).toBe('P***');
    expect(redacted.outboundQueue[0].content).toBe('[redacted len=10]');
    expect(redacted.outboundQueue[0].replyTo).toBe('[redacted len=26]');
    expect(redacted.outboundQueue[0].mediaUrl).toBe('[redacted len=47]');
  });
});

describe('redactStatusRecord', () => {
  it('masks errorMessage / errorDetail content but keeps codes and statuses', () => {
    const record = applyStatusUpdate(undefined, {
      messageHandle: 'm1',
      status: 'ERROR',
      errorCode: '4000',
      errorMessage: 'invalid input on field foo',
      errorDetail: 'super secret tail',
      raw: {}
    });
    const redacted = redactStatusRecord(record);
    expect(redacted.errorCode).toBe('4000');
    expect(redacted.terminalStatus).toBe('ERROR');
    expect(redacted.errorMessage).toBe('[redacted len=26]');
    expect(redacted.errorDetail).toBe('[redacted len=17]');
    expect(redacted.events[0].errorMessage).toBe('[redacted len=26]');
  });
});
