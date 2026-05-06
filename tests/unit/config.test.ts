import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/env.js';

describe('loadConfig', () => {
  it('loads required runtime configuration', () => {
    const config = loadConfig({
      PORT: '4321',
      PUBLIC_BASE_URL: 'https://agent.example.test/',
      CHAT_ENDPOINT_URL: 'https://chat.example.test/chat',
      SENDBLUE_API_BASE_URL: 'https://api.sendblue.example.test/',
      SENDBLUE_API_KEY_ID: 'key-id',
      SENDBLUE_API_SECRET_KEY: 'secret-key',
      SENDBLUE_FROM_NUMBER: '+15552220000',
      SENDBLUE_WEBHOOK_SECRET: 'webhook-secret',
      SENDBLUE_WEBHOOK_SECRET_HEADER: 'x-custom-secret',
      CHAT_ENDPOINT_TIMEOUT_MS: '1234'
    });

    expect(config).toMatchObject({
      port: 4321,
      publicBaseUrl: 'https://agent.example.test',
      chatEndpointUrl: 'https://chat.example.test/chat',
      sendblueApiBaseUrl: 'https://api.sendblue.example.test',
      sendblueApiKeyId: 'key-id',
      sendblueApiSecretKey: 'secret-key',
      sendblueFromNumber: '+15552220000',
      sendblueWebhookSecret: 'webhook-secret',
      sendblueWebhookSecretHeader: 'x-custom-secret',
      chatEndpointTimeoutMs: 1234
    });
  });

  it('fails with a useful error when required env is absent', () => {
    expect(() => loadConfig({})).toThrow(/PUBLIC_BASE_URL/);
  });
});
