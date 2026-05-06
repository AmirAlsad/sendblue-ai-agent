import type { AgentConfig } from '../../src/config/env.js';

export function testConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    port: 0,
    publicBaseUrl: 'https://agent.example.test',
    chatEndpointUrl: 'https://chat.example.test/chat',
    sendblueApiBaseUrl: 'https://api.sendblue.example.test',
    sendblueApiKeyId: 'test-key-id',
    sendblueApiSecretKey: 'test-secret-key',
    sendblueFromNumber: '+15552220000',
    sendblueWebhookSecret: 'test-webhook-secret',
    sendblueWebhookSecretHeader: 'x-sendblue-test-secret',
    chatEndpointTimeoutMs: 1000,
    ...overrides
  };
}
