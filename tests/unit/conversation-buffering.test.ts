import { describe, expect, it } from 'vitest';
import { calculateBufferTimeout, truncateCancelledMessage } from '../../src/conversation/buffering.js';
import { aggregateMessageText } from '../../src/conversation/chat-request.js';
import type { InboundMessageItem } from '../../src/conversation/types.js';
import { testConfig } from '../helpers/config.js';

function item(content: string, messageHandle: string): InboundMessageItem {
  return {
    content,
    messageHandle,
    fromNumber: '+15551110001',
    toNumber: '+15552220000',
    channel: 'imessage',
    wasDowngraded: false,
    mediaUrl: '',
    messageType: 'message',
    sendStyle: '',
    raw: {},
    receivedAt: '2026-05-06T12:00:00.000Z'
  };
}

describe('conversation buffering helpers', () => {
  it('calculates exponential timeouts with caps and optional noise', () => {
    const config = testConfig({
      bufferBaseTimeoutMs: 2000,
      bufferGrowthFactor: 2,
      bufferMaxTimeoutMs: 5000,
      bufferNoiseMaxDeviation: 0
    });

    expect(calculateBufferTimeout(1, config)).toBe(2000);
    expect(calculateBufferTimeout(2, config)).toBe(4000);
    expect(calculateBufferTimeout(3, config)).toBe(5000);
  });

  it('aggregates buffered text with the public delimiter', () => {
    expect(aggregateMessageText([item('first', '1'), item('second', '2')])).toBe('first\n---\nsecond');
  });

  it('truncates cancelled outbound interruption context', () => {
    expect(truncateCancelledMessage('abcdefghij', 5)).toBe('abcde...');
    expect(truncateCancelledMessage('abc', 5)).toBe('abc');
  });
});
