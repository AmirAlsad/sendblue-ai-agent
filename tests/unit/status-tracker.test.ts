import { describe, expect, it } from 'vitest';
import {
  applyStatusUpdate,
  classifyErrorCode,
  createStatusRecord,
  InMemoryStatusStore,
  isDocumentedErrorCode,
  isTransientErrorCode,
  TERMINAL_STATUSES
} from '../../src/status/tracker.js';
import type { SendblueStatusWebhook } from '../../src/sendblue/types.js';

describe('status tracker', () => {
  it('tracks lifecycle history and terminal delivery', () => {
    let record = applyStatusUpdate(undefined, {
      messageHandle: 'outbound-001',
      status: 'REGISTERED',
      raw: {}
    });
    record = applyStatusUpdate(record, {
      messageHandle: 'outbound-001',
      status: 'PENDING',
      raw: {}
    });
    record = applyStatusUpdate(record, {
      messageHandle: 'outbound-001',
      status: 'DELIVERED',
      raw: {}
    });

    expect(record.history).toEqual(['REGISTERED', 'PENDING', 'DELIVERED']);
    expect(record.terminalStatus).toBe('DELIVERED');
  });

  it('walks the full documented eight-status lifecycle', () => {
    // Sendblue documents exactly: REGISTERED, PENDING, DECLINED, QUEUED,
    // ACCEPTED, SENT, DELIVERED, ERROR. Walk a representative non-erroring
    // path that exercises the non-terminal statuses too.
    const handle = 'outbound-lifecycle';
    let record = applyStatusUpdate(undefined, { messageHandle: handle, status: 'REGISTERED', raw: {} });
    record = applyStatusUpdate(record, { messageHandle: handle, status: 'PENDING', raw: {} });
    record = applyStatusUpdate(record, { messageHandle: handle, status: 'QUEUED', raw: {} });
    record = applyStatusUpdate(record, { messageHandle: handle, status: 'ACCEPTED', raw: {} });
    record = applyStatusUpdate(record, { messageHandle: handle, status: 'SENT', raw: {} });
    record = applyStatusUpdate(record, { messageHandle: handle, status: 'DELIVERED', raw: {} });
    expect(record.history).toEqual(['REGISTERED', 'PENDING', 'QUEUED', 'ACCEPTED', 'SENT', 'DELIVERED']);
    expect(record.events.map(e => e.status)).toEqual(record.history);
    expect(record.terminalStatus).toBe('DELIVERED');
  });

  it('does not duplicate adjacent retry statuses', () => {
    let record = applyStatusUpdate(undefined, {
      messageHandle: 'outbound-001',
      status: 'QUEUED',
      raw: {}
    });
    record = applyStatusUpdate(record, {
      messageHandle: 'outbound-001',
      status: 'QUEUED',
      raw: {}
    });

    expect(record.history).toEqual(['QUEUED']);
  });

  it('records every callback as an event even when history is deduplicated', () => {
    // Sendblue retries webhooks up to 3x on 5xx — adjacent duplicate
    // statuses are noise for `history` but still meaningful for
    // operational dashboards and timeline diagnostics. Both must be kept.
    let record = applyStatusUpdate(undefined, {
      messageHandle: 'outbound-retry',
      status: 'QUEUED',
      raw: {}
    });
    record = applyStatusUpdate(record, { messageHandle: 'outbound-retry', status: 'QUEUED', raw: {} });
    record = applyStatusUpdate(record, { messageHandle: 'outbound-retry', status: 'QUEUED', raw: {} });
    expect(record.history).toEqual(['QUEUED']);
    expect(record.events).toHaveLength(3);
  });

  it('records terminal error details and classifies the error code', () => {
    const record = applyStatusUpdate(undefined, {
      messageHandle: 'outbound-error-001',
      status: 'ERROR',
      errorCode: 'SMS_LIMIT_REACHED',
      errorMessage: 'SMS limit reached',
      errorDetail: 'Try again later',
      raw: {}
    });

    expect(record).toMatchObject({
      terminalStatus: 'ERROR',
      errorCode: 'SMS_LIMIT_REACHED',
      errorMessage: 'SMS limit reached',
      errorDetail: 'Try again later',
      errorCategory: 'sms_limit'
    });
  });

  it('captures error_reason from the status callback when present', () => {
    // Sendblue's documented status callback payload includes `error_reason`
    // alongside `error_message` and `error_detail`. We accept it on the
    // SendblueStatusWebhook even if the parser does not yet populate it.
    const update: SendblueStatusWebhook & { errorReason?: string } = {
      messageHandle: 'outbound-error-reason',
      status: 'ERROR',
      errorCode: '4000',
      errorReason: 'invalid_to_number',
      raw: {}
    };
    const record = applyStatusUpdate(undefined, update);
    expect(record.errorReason).toBe('invalid_to_number');
    expect(record.errorCategory).toBe('validation');
  });

  it('marks DECLINED as a terminal status', () => {
    const record = applyStatusUpdate(undefined, {
      messageHandle: 'outbound-declined',
      status: 'DECLINED',
      raw: {}
    });
    expect(record.terminalStatus).toBe('DECLINED');
    expect(TERMINAL_STATUSES.has('DECLINED')).toBe(true);
  });

  it('does not mark SENT as terminal at the tracker layer', () => {
    // SENT is terminal for SMS and downgraded conversations, but the
    // conversation agent owns that channel-aware decision. The tracker
    // intentionally stays conservative.
    const record = applyStatusUpdate(undefined, {
      messageHandle: 'outbound-sent',
      status: 'SENT',
      raw: {}
    });
    expect(record.terminalStatus).toBeUndefined();
  });

  it('preserves was_downgraded as sticky state across callbacks', () => {
    let record = applyStatusUpdate(undefined, {
      messageHandle: 'outbound-downgrade',
      status: 'QUEUED',
      wasDowngraded: false,
      raw: {}
    });
    record = applyStatusUpdate(record, {
      messageHandle: 'outbound-downgrade',
      status: 'SENT',
      wasDowngraded: true,
      service: 'SMS',
      raw: {}
    });
    // A later callback may omit was_downgraded; the record must still remember.
    record = applyStatusUpdate(record, {
      messageHandle: 'outbound-downgrade',
      status: 'DELIVERED',
      raw: {}
    });
    expect(record.wasDowngraded).toBe(true);
    expect(record.lastService).toBe('SMS');
  });

  it('tracks service per event without overwriting historical events', () => {
    let record = applyStatusUpdate(undefined, {
      messageHandle: 'outbound-service',
      status: 'QUEUED',
      service: 'iMessage',
      raw: {}
    });
    record = applyStatusUpdate(record, {
      messageHandle: 'outbound-service',
      status: 'SENT',
      service: 'SMS',
      raw: {}
    });
    expect(record.events.map(e => e.service)).toEqual(['iMessage', 'SMS']);
    expect(record.service).toBe('iMessage');
    expect(record.lastService).toBe('SMS');
  });

  it('records receivedAt timestamps on every event', () => {
    const now = (() => {
      const dates = ['2026-05-04T19:00:00.000Z', '2026-05-04T19:00:01.000Z'];
      let i = 0;
      return () => new Date(dates[Math.min(i++, dates.length - 1)]);
    })();
    let record = applyStatusUpdate(
      undefined,
      { messageHandle: 'h', status: 'QUEUED', raw: {} },
      { now }
    );
    record = applyStatusUpdate(
      record,
      { messageHandle: 'h', status: 'SENT', raw: {} },
      { now }
    );
    expect(record.events[0].receivedAt).toBe('2026-05-04T19:00:00.000Z');
    expect(record.events[1].receivedAt).toBe('2026-05-04T19:00:01.000Z');
    expect(record.lastUpdatedAt).toBe('2026-05-04T19:00:01.000Z');
  });

  it('does not mutate the input record', () => {
    const initial = createStatusRecord('immut');
    const next = applyStatusUpdate(initial, { messageHandle: 'immut', status: 'QUEUED', raw: {} });
    expect(initial.history).toEqual([]);
    expect(initial.events).toEqual([]);
    expect(next).not.toBe(initial);
  });

  it('handles ERROR -> retry-style status sequence without losing terminality', () => {
    let record = applyStatusUpdate(undefined, {
      messageHandle: 'flake',
      status: 'ERROR',
      errorCode: '5000',
      errorMessage: 'Internal error',
      raw: {}
    });
    // Even if a stale callback arrives later, terminal stays terminal.
    record = applyStatusUpdate(record, { messageHandle: 'flake', status: 'QUEUED', raw: {} });
    expect(record.terminalStatus).toBe('ERROR');
    expect(record.errorCategory).toBe('server');
  });
});

describe('error code classification', () => {
  it('classifies every documented Sendblue error code', () => {
    expect(classifyErrorCode('4000')).toBe('validation');
    expect(classifyErrorCode('4001')).toBe('rate_limit');
    expect(classifyErrorCode('4002')).toBe('blacklist');
    expect(classifyErrorCode('5000')).toBe('server');
    expect(classifyErrorCode('5003')).toBe('rate_limit');
    expect(classifyErrorCode('5509')).toBe('rate_limit');
    expect(classifyErrorCode('10001')).toBe('send_failed');
    expect(classifyErrorCode('10002')).toBe('status_unresolved');
    expect(classifyErrorCode('SMS_LIMIT_REACHED')).toBe('sms_limit');
  });

  it('accepts numeric codes (Sendblue documents error_code as int)', () => {
    expect(classifyErrorCode(4000)).toBe('validation');
    expect(classifyErrorCode(5509)).toBe('rate_limit');
  });

  it('returns unknown for undocumented codes without throwing', () => {
    expect(classifyErrorCode(undefined)).toBe('unknown');
    expect(classifyErrorCode(null)).toBe('unknown');
    expect(classifyErrorCode('9999')).toBe('unknown');
    expect(classifyErrorCode('')).toBe('unknown');
  });

  it('flags transient categories for retry-aware callers', () => {
    expect(isTransientErrorCode('5000')).toBe(true);
    expect(isTransientErrorCode('5509')).toBe(true);
    expect(isTransientErrorCode('SMS_LIMIT_REACHED')).toBe(true);
    expect(isTransientErrorCode('10002')).toBe(true);
    expect(isTransientErrorCode('4000')).toBe(false);
    expect(isTransientErrorCode('4002')).toBe(false);
    expect(isTransientErrorCode('10001')).toBe(false);
  });

  it('recognizes documented vs undocumented codes', () => {
    expect(isDocumentedErrorCode('4000')).toBe(true);
    expect(isDocumentedErrorCode('SMS_LIMIT_REACHED')).toBe(true);
    expect(isDocumentedErrorCode('9999')).toBe(false);
    expect(isDocumentedErrorCode(null)).toBe(false);
  });
});

describe('InMemoryStatusStore', () => {
  it('keeps independent records per message_handle', () => {
    const store = new InMemoryStatusStore();
    store.apply({ messageHandle: 'a', status: 'QUEUED', raw: {} });
    store.apply({ messageHandle: 'b', status: 'DELIVERED', raw: {} });
    expect(store.get('a')?.terminalStatus).toBeUndefined();
    expect(store.get('b')?.terminalStatus).toBe('DELIVERED');
    expect(store.all()).toHaveLength(2);
  });

  it('clear empties the store', () => {
    const store = new InMemoryStatusStore();
    store.apply({ messageHandle: 'a', status: 'QUEUED', raw: {} });
    store.clear();
    expect(store.all()).toHaveLength(0);
  });
});
