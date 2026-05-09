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
      IDENTITY_RESOLVER_TIMEOUT_MS: '750',
      OUTBOUND_TYPING_INDICATORS_ENABLED: 'false',
      READ_RECEIPTS_ENABLED: 'true',
      READ_RECEIPT_DEBOUNCE_MS: '222',
      TYPING_START_DELAY_MS: '250',
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
      identityResolverTimeoutMs: 750,
      outboundTypingIndicatorsEnabled: false,
      readReceiptsEnabled: true,
      readReceiptDebounceMs: 222,
      typingStartDelayMs: 250,
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
      typingStartDelayMs: 500,
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

  it('reports each required env var by name when missing', () => {
    const baseRequired: Record<string, string> = {
      PUBLIC_BASE_URL: 'https://agent.example.test',
      CHAT_ENDPOINT_URL: 'https://chat.example.test/chat',
      SENDBLUE_API_KEY_ID: 'key-id',
      SENDBLUE_API_SECRET_KEY: 'secret-key',
      SENDBLUE_FROM_NUMBER: '+15552220000'
    };

    for (const name of Object.keys(baseRequired)) {
      const env = { ...baseRequired };
      delete env[name];
      expect(() => loadConfig(env)).toThrowError(new RegExp(name));
    }
  });

  it('treats blank required env vars as missing', () => {
    expect(() =>
      loadConfig({
        PUBLIC_BASE_URL: '   ',
        CHAT_ENDPOINT_URL: 'https://chat.example.test/chat',
        SENDBLUE_API_KEY_ID: 'key-id',
        SENDBLUE_API_SECRET_KEY: 'secret-key',
        SENDBLUE_FROM_NUMBER: '+15552220000'
      })
    ).toThrow(/PUBLIC_BASE_URL/);
  });

  it('rejects non-numeric integer env vars', () => {
    expect(() =>
      loadConfig({
        PUBLIC_BASE_URL: 'https://agent.example.test',
        CHAT_ENDPOINT_URL: 'https://chat.example.test/chat',
        SENDBLUE_API_KEY_ID: 'key-id',
        SENDBLUE_API_SECRET_KEY: 'secret-key',
        SENDBLUE_FROM_NUMBER: '+15552220000',
        DEDUPE_TTL_SECONDS: 'not-a-number'
      })
    ).toThrow(/DEDUPE_TTL_SECONDS/);
  });

  it('defaults identityResolverTimeoutMs to 5000 and dedupeTtlSeconds to 86400', () => {
    const config = loadConfig({
      PUBLIC_BASE_URL: 'https://agent.example.test',
      CHAT_ENDPOINT_URL: 'https://chat.example.test/chat',
      SENDBLUE_API_KEY_ID: 'key-id',
      SENDBLUE_API_SECRET_KEY: 'secret-key',
      SENDBLUE_FROM_NUMBER: '+15552220000'
    });

    expect(config.identityResolverTimeoutMs).toBe(5000);
    expect(config.dedupeTtlSeconds).toBe(86400);
    expect(config.conversationTtlSeconds).toBe(86400);
    expect(config.userLookupUrl).toBeUndefined();
    expect(config.redisUrl).toBeUndefined();
    expect(config.sendblueWebhookSecret).toBeUndefined();
    expect(config.sendblueWebhookSecretHeader).toBe('sb-signing-secret');
    expect(config.bufferQueueName).toBe('sendblue-buffer-timers');
  });

  it('parses booleans loosely and defaults unspecified booleans', () => {
    const yes = loadConfig({
      PUBLIC_BASE_URL: 'https://agent.example.test',
      CHAT_ENDPOINT_URL: 'https://chat.example.test/chat',
      SENDBLUE_API_KEY_ID: 'key-id',
      SENDBLUE_API_SECRET_KEY: 'secret-key',
      SENDBLUE_FROM_NUMBER: '+15552220000',
      READ_RECEIPTS_ENABLED: 'YES',
      OUTBOUND_TYPING_INDICATORS_ENABLED: 'on',
      INBOUND_TYPING_STATE_ENABLED: '1',
      VALID_USER_REQUIRED: 'true'
    });

    expect(yes.readReceiptsEnabled).toBe(true);
    expect(yes.outboundTypingIndicatorsEnabled).toBe(true);
    expect(yes.inboundTypingStateEnabled).toBe(true);
    expect(yes.validUserRequired).toBe(true);

    const no = loadConfig({
      PUBLIC_BASE_URL: 'https://agent.example.test',
      CHAT_ENDPOINT_URL: 'https://chat.example.test/chat',
      SENDBLUE_API_KEY_ID: 'key-id',
      SENDBLUE_API_SECRET_KEY: 'secret-key',
      SENDBLUE_FROM_NUMBER: '+15552220000',
      READ_RECEIPTS_ENABLED: 'maybe'
    });
    expect(no.readReceiptsEnabled).toBe(false);
  });

  it('strips trailing slashes from base URLs', () => {
    const config = loadConfig({
      PUBLIC_BASE_URL: 'https://agent.example.test///',
      CHAT_ENDPOINT_URL: 'https://chat.example.test/chat',
      SENDBLUE_API_KEY_ID: 'key-id',
      SENDBLUE_API_SECRET_KEY: 'secret-key',
      SENDBLUE_FROM_NUMBER: '+15552220000',
      SENDBLUE_API_BASE_URL: 'https://api.sendblue.example.test/',
      SENDBLUE_API_V2_BASE_URL: 'https://api-v2.sendblue.example.test/'
    });

    expect(config.publicBaseUrl).toBe('https://agent.example.test');
    expect(config.sendblueApiBaseUrl).toBe('https://api.sendblue.example.test');
    expect(config.sendblueApiV2BaseUrl).toBe('https://api-v2.sendblue.example.test');
  });

  it('strips angle brackets from chat response tag overrides', () => {
    const config = loadConfig({
      PUBLIC_BASE_URL: 'https://agent.example.test',
      CHAT_ENDPOINT_URL: 'https://chat.example.test/chat',
      SENDBLUE_API_KEY_ID: 'key-id',
      SENDBLUE_API_SECRET_KEY: 'secret-key',
      SENDBLUE_FROM_NUMBER: '+15552220000',
      CHAT_RESPONSE_MESSAGE_TAG: '<m>',
      CHAT_RESPONSE_REPLY_TAG: '</thread>'
    });

    expect(config.chatResponseTags.message).toBe('m');
    expect(config.chatResponseTags.reply).toBe('thread');
  });

  it('rejects SENDBLUE_FROM_NUMBER values that are not E.164', () => {
    const baseEnv = {
      PUBLIC_BASE_URL: 'https://agent.example.test',
      CHAT_ENDPOINT_URL: 'https://chat.example.test/chat',
      SENDBLUE_API_KEY_ID: 'key-id',
      SENDBLUE_API_SECRET_KEY: 'secret-key'
    };

    const invalid = [
      '++15552220000', // double-plus typo
      '15552220000', // missing leading +
      '+15-552-220-000', // dashes
      '+1 555 222 0000', // spaces
      '+1', // too short
      '+12345678901234567' // too long
    ];

    for (const value of invalid) {
      expect(() => loadConfig({ ...baseEnv, SENDBLUE_FROM_NUMBER: value })).toThrow(/Invalid E\.164/);
    }
  });

  it('accepts valid E.164 SENDBLUE_FROM_NUMBER values across the documented length range', () => {
    const baseEnv = {
      PUBLIC_BASE_URL: 'https://agent.example.test',
      CHAT_ENDPOINT_URL: 'https://chat.example.test/chat',
      SENDBLUE_API_KEY_ID: 'key-id',
      SENDBLUE_API_SECRET_KEY: 'secret-key'
    };

    for (const value of ['+15552220000', '+447911123456', '+1234567890', '+123456789012345']) {
      expect(loadConfig({ ...baseEnv, SENDBLUE_FROM_NUMBER: value }).sendblueFromNumber).toBe(value);
    }
  });

  describe('round-2 validation', () => {
    const baseRequired = {
      PUBLIC_BASE_URL: 'https://agent.example.test',
      CHAT_ENDPOINT_URL: 'https://chat.example.test/chat',
      SENDBLUE_API_KEY_ID: 'key-id',
      SENDBLUE_API_SECRET_KEY: 'secret-key',
      SENDBLUE_FROM_NUMBER: '+15552220000'
    };

    it('rejects SENDBLUE_CONTACTS_DEDUPE_TTL_SECONDS=0', () => {
      expect(() =>
        loadConfig({ ...baseRequired, SENDBLUE_CONTACTS_DEDUPE_TTL_SECONDS: '0' })
      ).toThrow(/SENDBLUE_CONTACTS_DEDUPE_TTL_SECONDS/);
    });

    it('rejects SMS_LIMIT_RETRY_INTERVAL_MS=0 and SMS_LIMIT_MAX_ATTEMPTS=0', () => {
      expect(() =>
        loadConfig({ ...baseRequired, SMS_LIMIT_RETRY_INTERVAL_MS: '0' })
      ).toThrow(/SMS_LIMIT_RETRY_INTERVAL_MS/);
      expect(() =>
        loadConfig({ ...baseRequired, SMS_LIMIT_MAX_ATTEMPTS: '0' })
      ).toThrow(/SMS_LIMIT_MAX_ATTEMPTS/);
    });

    it('rejects warn > limit for inbound contacts threshold', () => {
      expect(() =>
        loadConfig({
          ...baseRequired,
          INBOUND_CONTACTS_PER_DAY_WARN_THRESHOLD: '900',
          INBOUND_CONTACTS_PER_DAY_LIMIT: '500'
        })
      ).toThrow(/INBOUND_CONTACTS_PER_DAY_WARN_THRESHOLD=900 must be <= INBOUND_CONTACTS_PER_DAY_LIMIT=500/);
    });

    it('rejects warn > limit for follow-up daily threshold', () => {
      expect(() =>
        loadConfig({
          ...baseRequired,
          FOLLOW_UP_DAILY_WARN_THRESHOLD: '300',
          FOLLOW_UP_DAILY_LIMIT: '200'
        })
      ).toThrow(/FOLLOW_UP_DAILY_WARN_THRESHOLD=300 must be <= FOLLOW_UP_DAILY_LIMIT=200/);
    });

    it('rejects hour > day for outbound rate limits', () => {
      expect(() =>
        loadConfig({
          ...baseRequired,
          OUTBOUND_RATE_LIMIT_PER_HOUR: '5000',
          OUTBOUND_RATE_LIMIT_PER_DAY: '4000'
        })
      ).toThrow(/OUTBOUND_RATE_LIMIT_PER_HOUR=5000 must be <= OUTBOUND_RATE_LIMIT_PER_DAY=4000/);
    });

    it('rejects transient base > max', () => {
      expect(() =>
        loadConfig({
          ...baseRequired,
          TRANSIENT_RETRY_BASE_MS: '100000',
          TRANSIENT_RETRY_MAX_MS: '60000'
        })
      ).toThrow(/TRANSIENT_RETRY_BASE_MS=100000 must be <= TRANSIENT_RETRY_MAX_MS=60000/);
    });

    it('accepts equal warn and limit values', () => {
      const config = loadConfig({
        ...baseRequired,
        INBOUND_CONTACTS_PER_DAY_WARN_THRESHOLD: '500',
        INBOUND_CONTACTS_PER_DAY_LIMIT: '500'
      });
      expect(config.inboundContactsPerDayWarnThreshold).toBe(500);
      expect(config.inboundContactsPerDayLimit).toBe(500);
    });
  });
});
