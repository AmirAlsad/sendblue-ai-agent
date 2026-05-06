import { DEFAULT_CHAT_RESPONSE_TAGS, type ChatResponseTagNames } from '../chat/types.js';

export type AgentConfig = {
  port: number;
  publicBaseUrl: string;
  chatEndpointUrl: string;
  sendblueApiKeyId: string;
  sendblueApiSecretKey: string;
  sendblueApiBaseUrl: string;
  sendblueApiV2BaseUrl: string;
  sendblueFromNumber: string;
  sendblueWebhookSecret?: string;
  sendblueWebhookSecretHeader: string;
  chatEndpointTimeoutMs: number;
  redisUrl?: string;
  conversationTtlSeconds: number;
  dedupeTtlSeconds: number;
  bufferBaseTimeoutMs: number;
  bufferGrowthFactor: number;
  bufferMaxTimeoutMs: number;
  bufferNoiseMaxDeviation: number;
  maxReprocessAttempts: number;
  cancelledMessageMaxLength: number;
  bufferQueueName: string;
  outboundDeliveryTimeoutMs: number;
  userLookupUrl?: string;
  outboundTypingIndicatorsEnabled: boolean;
  inboundTypingStateEnabled: boolean;
  readReceiptsEnabled: boolean;
  readReceiptDebounceMs: number;
  typingRefreshIntervalMs: number;
  typingRefreshMaxMs: number;
  agentDisplayName: string;
  validUserRequired: boolean;
  chatResponseParseTags: boolean;
  chatResponseTags: ChatResponseTagNames;
};

export type ConfigEnv = Record<string, string | undefined>;

function requireEnv(env: ConfigEnv, name: string): string {
  const value = env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalInt(env: ConfigEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid integer environment variable: ${name}`);
  }
  return parsed;
}

function optionalFloat(env: ConfigEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid number environment variable: ${name}`);
  }
  return parsed;
}

function optionalBoolean(env: ConfigEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function optionalString(env: ConfigEnv, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  return raw;
}

function optionalTagName(env: ConfigEnv, name: string, fallback: string): string {
  const raw = env[name];
  if (!raw || raw.trim() === '') return fallback;
  return raw.trim().replace(/^<\/?/, '').replace(/\/?>$/, '');
}

export function loadConfig(env: ConfigEnv = process.env): AgentConfig {
  return {
    port: optionalInt(env, 'PORT', 3000),
    publicBaseUrl: requireEnv(env, 'PUBLIC_BASE_URL').replace(/\/+$/, ''),
    chatEndpointUrl: requireEnv(env, 'CHAT_ENDPOINT_URL'),
    sendblueApiKeyId: requireEnv(env, 'SENDBLUE_API_KEY_ID'),
    sendblueApiSecretKey: requireEnv(env, 'SENDBLUE_API_SECRET_KEY'),
    sendblueApiBaseUrl: (env.SENDBLUE_API_BASE_URL || 'https://api.sendblue.co').replace(/\/+$/, ''),
    sendblueApiV2BaseUrl: (env.SENDBLUE_API_V2_BASE_URL || 'https://api.sendblue.com').replace(/\/+$/, ''),
    sendblueFromNumber: requireEnv(env, 'SENDBLUE_FROM_NUMBER'),
    sendblueWebhookSecret: env.SENDBLUE_WEBHOOK_SECRET || undefined,
    sendblueWebhookSecretHeader:
      env.SENDBLUE_WEBHOOK_SECRET_HEADER || 'sb-signing-secret',
    chatEndpointTimeoutMs: optionalInt(env, 'CHAT_ENDPOINT_TIMEOUT_MS', 10000),
    redisUrl: env.REDIS_URL || undefined,
    conversationTtlSeconds: optionalInt(env, 'CONVERSATION_TTL_SECONDS', 86400),
    dedupeTtlSeconds: optionalInt(env, 'DEDUPE_TTL_SECONDS', 86400),
    bufferBaseTimeoutMs: optionalInt(env, 'BUFFER_BASE_TIMEOUT_MS', 2000),
    bufferGrowthFactor: optionalFloat(env, 'BUFFER_GROWTH_FACTOR', 1.25),
    bufferMaxTimeoutMs: optionalInt(env, 'BUFFER_MAX_TIMEOUT_MS', 8000),
    bufferNoiseMaxDeviation: optionalFloat(env, 'BUFFER_NOISE_MAX_DEVIATION', 0.3),
    maxReprocessAttempts: optionalInt(env, 'MAX_REPROCESS_ATTEMPTS', 2),
    cancelledMessageMaxLength: optionalInt(env, 'CANCELLED_MESSAGE_MAX_LENGTH', 150),
    bufferQueueName: env.BUFFER_QUEUE_NAME || 'sendblue-buffer-timers',
    outboundDeliveryTimeoutMs: optionalInt(env, 'OUTBOUND_DELIVERY_TIMEOUT_MS', 30000),
    userLookupUrl: env.USER_LOOKUP_URL || undefined,
    outboundTypingIndicatorsEnabled: optionalBoolean(env, 'OUTBOUND_TYPING_INDICATORS_ENABLED', true),
    inboundTypingStateEnabled: optionalBoolean(env, 'INBOUND_TYPING_STATE_ENABLED', true),
    readReceiptsEnabled: optionalBoolean(env, 'READ_RECEIPTS_ENABLED', false),
    readReceiptDebounceMs: optionalInt(env, 'READ_RECEIPT_DEBOUNCE_MS', 250),
    typingRefreshIntervalMs: optionalInt(env, 'TYPING_REFRESH_INTERVAL_MS', 5000),
    typingRefreshMaxMs: optionalInt(env, 'TYPING_REFRESH_MAX_MS', 120000),
    agentDisplayName: optionalString(env, 'AGENT_DISPLAY_NAME') ?? 'sb-agent',
    validUserRequired: optionalBoolean(env, 'VALID_USER_REQUIRED', false),
    chatResponseParseTags: optionalBoolean(env, 'CHAT_RESPONSE_PARSE_TAGS', true),
    chatResponseTags: {
      message: optionalTagName(env, 'CHAT_RESPONSE_MESSAGE_TAG', DEFAULT_CHAT_RESPONSE_TAGS.message),
      noResponse: optionalTagName(env, 'CHAT_RESPONSE_NO_RESPONSE_TAG', DEFAULT_CHAT_RESPONSE_TAGS.noResponse),
      reaction: optionalTagName(env, 'CHAT_RESPONSE_REACTION_TAG', DEFAULT_CHAT_RESPONSE_TAGS.reaction),
      reply: optionalTagName(env, 'CHAT_RESPONSE_REPLY_TAG', DEFAULT_CHAT_RESPONSE_TAGS.reply)
    }
  };
}
