import { describe, expect, it, vi } from 'vitest';
import { readSetupEnv } from '../../../scripts/e2e/lib/env.js';
import { SendblueWebhookClient } from '../../../scripts/e2e/lib/sendblue-webhooks.js';
import { CAPTURE_MANAGED_WEBHOOK_TYPES } from '../../../src/sendblue/webhook-types.js';

describe('SendblueWebhookClient', () => {
  it('updates existing managed webhooks instead of appending duplicates', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          webhooks: {
            receive: ['https://old.example/receive'],
            outbound: ['https://old.example/status'],
            typing_indicator: ['https://existing.example/typing'],
            globalSecret: 'global-secret'
          }
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
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.sendblue.example.test/api/account/webhooks');
    expect(fetchMock.mock.calls[1][1].method).toBe('PUT');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      webhooks: {
        receive: [{ url: 'https://agent.example.test/webhook/receive', secret: 'webhook-secret' }],
        outbound: [{ url: 'https://agent.example.test/webhook/status', secret: 'webhook-secret' }],
        typing_indicator: ['https://existing.example/typing'],
        globalSecret: 'global-secret'
      }
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
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      webhooks: ['https://agent.example.test/webhook/receive'],
      type: 'receive'
    });
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({
      webhooks: ['https://agent.example.test/webhook/status'],
      type: 'outbound'
    });
  });

  it('can manage every Sendblue webhook type for capture sessions', async () => {
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
      'https://agent.example.test',
      { types: CAPTURE_MANAGED_WEBHOOK_TYPES }
    );

    expect(results.map(result => result.type)).toEqual([
      'receive',
      'outbound',
      'typing_indicator',
      'call_log',
      'line_blocked',
      'line_assigned',
      'contact_created'
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(8);
    expect(JSON.parse(fetchMock.mock.calls[3][1].body)).toEqual({
      webhooks: ['https://agent.example.test/webhook/typing-indicator'],
      type: 'typing_indicator'
    });
    expect(JSON.parse(fetchMock.mock.calls[7][1].body)).toEqual({
      webhooks: ['https://agent.example.test/webhook/contact-created'],
      type: 'contact_created'
    });
  });
});
