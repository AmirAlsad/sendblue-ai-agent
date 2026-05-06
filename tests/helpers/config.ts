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
    redisUrl: undefined,
    conversationTtlSeconds: 86400,
    dedupeTtlSeconds: 86400,
    bufferBaseTimeoutMs: 0,
    bufferGrowthFactor: 1.25,
    bufferMaxTimeoutMs: 0,
    bufferNoiseMaxDeviation: 0,
    maxReprocessAttempts: 2,
    cancelledMessageMaxLength: 150,
    bufferQueueName: 'test-buffer-timers',
    outboundDeliveryTimeoutMs: 30000,
    userLookupUrl: undefined,
    outboundTypingIndicatorsEnabled: true,
    inboundTypingStateEnabled: true,
    ...overrides
  };
}
