import { describe, expect, it } from 'vitest';
import {
  desiredWebhooks,
  normalizeWebhookList,
  SendblueWebhookClient,
  webhookType,
  webhookUrl
} from '../../../scripts/e2e/lib/sendblue-webhooks.js';
import { CAPTURE_MANAGED_WEBHOOK_TYPES } from '../../../src/sendblue/webhook-types.js';

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

  it('builds capture targets for every known Sendblue webhook type', () => {
    expect(desiredWebhooks('https://agent.example.test/', 'secret', CAPTURE_MANAGED_WEBHOOK_TYPES)).toEqual([
      {
        type: 'receive',
        url: 'https://agent.example.test/webhook/receive',
        secret: 'secret'
      },
      {
        type: 'outbound',
        url: 'https://agent.example.test/webhook/status',
        secret: 'secret'
      },
      {
        type: 'typing_indicator',
        url: 'https://agent.example.test/webhook/typing-indicator',
        secret: 'secret'
      },
      {
        type: 'call_log',
        url: 'https://agent.example.test/webhook/call-log',
        secret: 'secret'
      },
      {
        type: 'line_blocked',
        url: 'https://agent.example.test/webhook/line-blocked',
        secret: 'secret'
      },
      {
        type: 'line_assigned',
        url: 'https://agent.example.test/webhook/line-assigned',
        secret: 'secret'
      },
      {
        type: 'contact_created',
        url: 'https://agent.example.test/webhook/contact-created',
        secret: 'secret'
      }
    ]);
  });

  it('normalizes common list response shapes', () => {
    expect(normalizeWebhookList([{ id: '1', type: 'receive' }])).toHaveLength(1);
    expect(normalizeWebhookList({ webhooks: [{ id: '2', event_type: 'outbound' }] })).toHaveLength(1);
    expect(normalizeWebhookList({ data: [{ id: '3', webhook_type: 'receive' }] })).toHaveLength(1);
    expect(
      normalizeWebhookList({
        webhooks: {
          receive: ['https://agent.example.test/webhook/receive'],
          outbound: [{ url: 'https://agent.example.test/webhook/status', secret: 'secret' }],
          globalSecret: 'global-secret'
        }
      })
    ).toEqual([
      {
        type: 'receive',
        url: 'https://agent.example.test/webhook/receive'
      },
      {
        type: 'outbound',
        url: 'https://agent.example.test/webhook/status',
        secret: 'secret'
      }
    ]);
  });

  it('reads webhook type and URL from compatible field names', () => {
    expect(webhookType({ event_type: 'receive' })).toBe('receive');
    expect(webhookType({ webhook_type: 'outbound' })).toBe('outbound');
    expect(webhookUrl({ endpoint: 'https://agent.example.test/webhook/status' })).toBe(
      'https://agent.example.test/webhook/status'
    );
  });

  it('sends contact_created as a plain URL during replacement because Sendblue rejects object values', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (!init?.method || init.method === 'GET') {
        return Response.json({
          webhooks: {
            receive: [{ url: 'https://old.example.test/webhook/receive', secret: 'secret' }],
            contact_created: ['https://old.example.test/webhook/contact-created']
          }
        });
      }
      return Response.json({ status: 'OK' });
    }) as typeof fetch;

    const client = new SendblueWebhookClient(
      {
        agentPort: 3000,
        sendblueApiBaseUrl: 'https://api.sendblue.example.test',
        sendblueApiKeyId: 'key',
        sendblueApiSecretKey: 'secret',
        sendblueFromNumber: '+15552220000',
        sendblueWebhookSecret: 'webhook-secret',
        sendblueWebhookSecretHeader: 'sb-signing-secret',
        messagesDbPath: '~/Library/Messages/chat.db'
      },
      fetchImpl
    );

    await client.apply('https://agent.example.test', { types: CAPTURE_MANAGED_WEBHOOK_TYPES });

    const put = calls.find(call => call.init?.method === 'PUT');
    expect(put).toBeDefined();
    expect(JSON.parse(String(put!.init!.body)).webhooks.contact_created).toEqual([
      'https://agent.example.test/webhook/contact-created'
    ]);
  });
});
