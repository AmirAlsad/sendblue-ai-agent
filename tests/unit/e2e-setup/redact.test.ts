import { describe, expect, it } from 'vitest';
import { redactEnv, redactValue } from '../../../scripts/e2e/lib/redact.js';

describe('redaction helpers', () => {
  it('redacts secret-looking values', () => {
    expect(redactValue('SENDBLUE_API_SECRET_KEY', 'abcdef')).toBe('ab****ef');
    expect(redactValue('WEBHOOK_PASSWORD', 'pw')).toBe('****');
  });

  it('does not redact ordinary values', () => {
    expect(redactEnv({ E2E_AGENT_PORT: '3000', NGROK_AUTHTOKEN: 'token1234' })).toEqual({
      E2E_AGENT_PORT: '3000',
      NGROK_AUTHTOKEN: 'to****34'
    });
  });
});
