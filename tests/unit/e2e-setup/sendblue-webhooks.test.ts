import { describe, expect, it } from 'vitest';
import {
  desiredWebhooks,
  normalizeWebhookList,
  webhookType,
  webhookUrl
} from '../../../scripts/e2e/lib/sendblue-webhooks.js';

describe('Sendblue webhook setup helpers', () => {
  it('builds receive and outbound webhook targets', () => {
    expect(desiredWebhooks('https://agent.example.test/', 'secret')).toEqual([
      {
        type: 'receive',
        url: 'https://agent.example.test/webhook/receive',
        secret: 'secret'
      },
      {
        type: 'outbound',
        url: 'https://agent.example.test/webhook/status',
        secret: 'secret'
      }
    ]);
  });

  it('normalizes common list response shapes', () => {
    expect(normalizeWebhookList([{ id: '1', type: 'receive' }])).toHaveLength(1);
    expect(normalizeWebhookList({ webhooks: [{ id: '2', event_type: 'outbound' }] })).toHaveLength(1);
    expect(normalizeWebhookList({ data: [{ id: '3', webhook_type: 'receive' }] })).toHaveLength(1);
  });

  it('reads webhook type and URL from compatible field names', () => {
    expect(webhookType({ event_type: 'receive' })).toBe('receive');
    expect(webhookType({ webhook_type: 'outbound' })).toBe('outbound');
    expect(webhookUrl({ endpoint: 'https://agent.example.test/webhook/status' })).toBe(
      'https://agent.example.test/webhook/status'
    );
  });
});
