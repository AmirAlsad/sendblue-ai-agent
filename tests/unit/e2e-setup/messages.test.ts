import { describe, expect, it } from 'vitest';
import {
  appleDateFromUnixMs,
  buildMessagesReplyQuery,
  buildSendIMessageCommand,
  unixMsFromAppleDate
} from '../../../scripts/e2e/lib/messages.js';

describe('native Messages helpers', () => {
  it('converts between Unix milliseconds and Apple nanosecond timestamps', () => {
    const unixMs = Date.UTC(2026, 4, 5, 12, 0, 0);
    const appleDate = appleDateFromUnixMs(unixMs);

    expect(appleDate).toBe(799675200000000000n);
    expect(unixMsFromAppleDate(appleDate)).toBe(unixMs);
  });

  it('builds an osascript command with AppleScript-escaped message content', () => {
    const command = buildSendIMessageCommand({
      to: '+15551110001',
      content: 'quote " and slash \\ [sendblue-e2e:test]'
    });

    expect(command.command).toBe('osascript');
    expect(command.args).toHaveLength(2);
    expect(command.args[1]).toContain('buddy "+15551110001"');
    expect(command.args[1]).toContain('send "quote \\" and slash \\\\ [sendblue-e2e:test]"');
  });

  it('builds a read-only Messages query with escaped values and text-first matching', () => {
    const sql = buildMessagesReplyQuery({
      from: "+1555'1110001",
      contains: 'reply 100%_done',
      since: Date.UTC(2026, 4, 5, 12, 0, 0)
    });

    expect(sql).toContain("handle.id = '+1555''1110001'");
    expect(sql).toContain("message.text LIKE '%reply 100\\%\\_done%' ESCAPE '\\'");
    expect(sql).toContain('hex(message.attributedBody) AS attributedBodyHex');
    expect(sql).toContain('message.date >= 799675200000000000');
  });
});
