import { describe, expect, it } from 'vitest';
import { applyStatusUpdate } from '../../src/status/tracker.js';

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

  it('records terminal error details', () => {
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
      errorDetail: 'Try again later'
    });
  });
});
