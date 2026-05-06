import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/env.js';

describe('loadConfig', () => {
  it('loads required runtime configuration', () => {
    const config = loadConfig({
      PORT: '4321',
      PUBLIC_BASE_URL: 'https://agent.example.test/',
      CHAT_ENDPOINT_URL: 'https://chat.example.test/chat',
      SENDBLUE_API_BASE_URL: 'https://api.sendblue.example.test/',
      SENDBLUE_API_V2_BASE_URL: 'https://api-v2.sendblue.example.test/',
      SENDBLUE_API_KEY_ID: 'key-id',
      SENDBLUE_API_SECRET_KEY: 'secret-key',
      SENDBLUE_FROM_NUMBER: '+15552220000',
      SENDBLUE_WEBHOOK_SECRET: 'webhook-secret',
      SENDBLUE_WEBHOOK_SECRET_HEADER: 'x-custom-secret',
      CHAT_ENDPOINT_TIMEOUT_MS: '1234',
      REDIS_URL: 'redis://localhost:6379',
      BUFFER_BASE_TIMEOUT_MS: '100',
      BUFFER_GROWTH_FACTOR: '1.5',
      BUFFER_MAX_TIMEOUT_MS: '900',
      BUFFER_NOISE_MAX_DEVIATION: '0',
      MAX_REPROCESS_ATTEMPTS: '3',
      OUTBOUND_DELIVERY_TIMEOUT_MS: '4567',
      USER_LOOKUP_URL: 'https://users.example.test/lookup',
      OUTBOUND_TYPING_INDICATORS_ENABLED: 'false',
      READ_RECEIPTS_ENABLED: 'true',
      READ_RECEIPT_DEBOUNCE_MS: '222',
      TYPING_REFRESH_INTERVAL_MS: '3333',
      TYPING_REFRESH_MAX_MS: '12000',
      AGENT_DISPLAY_NAME: 'Support Agent',
      VALID_USER_REQUIRED: 'true',
      CHAT_RESPONSE_PARSE_TAGS: 'true',
      CHAT_RESPONSE_MESSAGE_TAG: '<msg>',
      CHAT_RESPONSE_NO_RESPONSE_TAG: 'quiet',
      CHAT_RESPONSE_REACTION_TAG: 'tapback',
      CHAT_RESPONSE_REPLY_TAG: 'thread_reply'
    });

    expect(config).toMatchObject({
      port: 4321,
      publicBaseUrl: 'https://agent.example.test',
      chatEndpointUrl: 'https://chat.example.test/chat',
      sendblueApiBaseUrl: 'https://api.sendblue.example.test',
      sendblueApiV2BaseUrl: 'https://api-v2.sendblue.example.test',
      sendblueApiKeyId: 'key-id',
      sendblueApiSecretKey: 'secret-key',
      sendblueFromNumber: '+15552220000',
      sendblueWebhookSecret: 'webhook-secret',
      sendblueWebhookSecretHeader: 'x-custom-secret',
      chatEndpointTimeoutMs: 1234,
      redisUrl: 'redis://localhost:6379',
      bufferBaseTimeoutMs: 100,
      bufferGrowthFactor: 1.5,
      bufferMaxTimeoutMs: 900,
      bufferNoiseMaxDeviation: 0,
      maxReprocessAttempts: 3,
      outboundDeliveryTimeoutMs: 4567,
      userLookupUrl: 'https://users.example.test/lookup',
      outboundTypingIndicatorsEnabled: false,
      readReceiptsEnabled: true,
      readReceiptDebounceMs: 222,
      typingRefreshIntervalMs: 3333,
      typingRefreshMaxMs: 12000,
      agentDisplayName: 'Support Agent',
      validUserRequired: true,
      chatResponseParseTags: true,
      chatResponseTags: {
        message: 'msg',
        noResponse: 'quiet',
        reaction: 'tapback',
        reply: 'thread_reply'
      }
    });
  });

  it('uses conservative rich capability defaults', () => {
    const config = loadConfig({
      PUBLIC_BASE_URL: 'https://agent.example.test',
      CHAT_ENDPOINT_URL: 'https://chat.example.test/chat',
      SENDBLUE_API_KEY_ID: 'key-id',
      SENDBLUE_API_SECRET_KEY: 'secret-key',
      SENDBLUE_FROM_NUMBER: '+15552220000'
    });

    expect(config).toMatchObject({
      sendblueApiBaseUrl: 'https://api.sendblue.co',
      sendblueApiV2BaseUrl: 'https://api.sendblue.com',
      readReceiptsEnabled: false,
      readReceiptDebounceMs: 250,
      typingRefreshIntervalMs: 5000,
      typingRefreshMaxMs: 120000,
      agentDisplayName: 'sb-agent',
      validUserRequired: false,
      chatResponseParseTags: true,
      chatResponseTags: {
        message: 'message',
        noResponse: 'no_response',
        reaction: 'reaction',
        reply: 'reply'
      }
    });
  });

  it('fails with a useful error when required env is absent', () => {
    expect(() => loadConfig({})).toThrow(/PUBLIC_BASE_URL/);
  });
});
