import { describe, expect, it, vi } from 'vitest';
import { readSetupEnv } from '../../../scripts/e2e/lib/env.js';
import { SendblueWebhookClient } from '../../../scripts/e2e/lib/sendblue-webhooks.js';

describe('SendblueWebhookClient', () => {
  it('updates existing managed webhooks instead of appending duplicates', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          webhooks: [
            { id: 'receive-1', type: 'receive', url: 'https://old.example/receive' },
            { id: 'outbound-1', type: 'outbound', url: 'https://old.example/status' }
          ]
        })
      })
      .mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });

    const env = readSetupEnv(
      {
        SENDBLUE_API_BASE_URL: 'https://api.sendblue.example.test',
        SENDBLUE_API_KEY_ID: 'key',
        SENDBLUE_API_SECRET_KEY: 'secret',
        SENDBLUE_FROM_NUMBER: '+15552220000',
        SENDBLUE_WEBHOOK_SECRET: 'webhook-secret'
      },
      { includeFiles: false }
    );

    const results = await new SendblueWebhookClient(env, fetchMock as never).apply(
      'https://agent.example.test'
    );

    expect(results.map(result => result.action)).toEqual(['updated', 'updated']);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://api.sendblue.example.test/api/account/webhooks/receive-1'
    );
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({
      type: 'receive',
      url: 'https://agent.example.test/webhook/receive',
      secret: 'webhook-secret'
    });
  });

  it('creates missing webhooks', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ webhooks: [] }) })
      .mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });

    const env = readSetupEnv(
      {
        SENDBLUE_API_BASE_URL: 'https://api.sendblue.example.test',
        SENDBLUE_API_KEY_ID: 'key',
        SENDBLUE_API_SECRET_KEY: 'secret',
        SENDBLUE_FROM_NUMBER: '+15552220000'
      },
      { includeFiles: false }
    );

    const results = await new SendblueWebhookClient(env, fetchMock as never).apply(
      'https://agent.example.test'
    );

    expect(results.map(result => result.action)).toEqual(['created', 'created']);
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.sendblue.example.test/api/account/webhooks');
    expect(fetchMock.mock.calls[1][1].method).toBe('POST');
  });
});
