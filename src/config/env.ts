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
  identityResolverTimeoutMs: number;
  outboundTypingIndicatorsEnabled: boolean;
  inboundTypingStateEnabled: boolean;
  readReceiptsEnabled: boolean;
  readReceiptDebounceMs: number;
  /**
   * Delay before the first outbound typing indicator fires after a chat
   * turn starts. If the chat endpoint returns silence (or any other empty
   * response) within this window, no typing call is ever sent — which
   * matters because Sendblue's iMessage typing bubble persists on the
   * device for ~60s after the last typing call. A non-zero default lets
   * fast/silence-returning bots avoid leaving a phantom typing bubble.
   */
  typingStartDelayMs: number;
  typingRefreshIntervalMs: number;
  typingRefreshMaxMs: number;
  agentDisplayName: string;
  validUserRequired: boolean;
  /**
   * When true (default), an inbound group message that contains a previously
   * delivered agent message as a substring counts as addressing the agent.
   * When false, only `@AGENT_DISPLAY_NAME` mentions and explicit reply
   * metadata referencing an agent outbound count. The default preserves
   * legacy behavior; set to false to avoid false-positive invocation on
   * short replies (e.g. agent sent "yes" → user later writes "yes please").
   */
  groupInvocationContentFallback: boolean;
  chatResponseParseTags: boolean;
  chatResponseTags: ChatResponseTagNames;
  /**
   * When true, the agent calls `POST /api/v2/contacts` (upsert) for every
   * inbound number it sees with a resolved identity that carries a name.
   * Default off — opt in once your `USER_LOOKUP_URL` returns name fields.
   * See `docs/features/contact-upsert.md`.
   */
  sendblueContactsEnabled: boolean;
  /**
   * Comma-separated tags applied to every Sendblue contact upserted by this
   * deployment (e.g. `agent,beta`). Merged with per-identity `tags`.
   */
  sendblueContactsDefaultTags: string[];
  /**
   * TTL (seconds) for the per-(line, number) dedupe set that prevents the
   * agent from re-upserting the same contact on every inbound. Default 30
   * days — long enough to avoid burning Sendblue's 100/10s contacts rate
   * budget on conversation churn, short enough that name updates eventually
   * reach Sendblue.
   */
  sendblueContactsDedupeTtlSeconds: number;
  /**
   * Per-line outbound rate Sendblue's docs allow on the Agent plan. The
   * tracker pre-emptively paces sends to stay below this — `acquireSendSlot`
   * delays in-process if a recent send is too close. Default `1` per
   * Sendblue's documented Agent-plan throughput.
   */
  outboundRateLimitPerSecond: number;
  /** Hourly outbound budget per line. Default `2000` per Sendblue Agent docs. */
  outboundRateLimitPerHour: number;
  /** Daily outbound budget per line. Default `4000` per Sendblue Agent docs. */
  outboundRateLimitPerDay: number;
  /** Warn-log threshold for the daily distinct-inbound counter. Default `800`. */
  inboundContactsPerDayWarnThreshold: number;
  /** Documented daily distinct-inbound limit on the Agent plan. Default `1000`. */
  inboundContactsPerDayLimit: number;
  /** Warn-log threshold for the daily follow-up counter. Default `160` (80% of 200). */
  followUpDailyWarnThreshold: number;
  /** Documented daily follow-up cap on the Agent plan (track-only). Default `200`. */
  followUpDailyLimit: number;
  /**
   * Sendblue's Agent plan grants unlimited outbound for the first
   * `replyWindowHours` after each inbound message. Sends after the window
   * count toward the daily follow-up cap. Default `24` per docs.
   */
  replyWindowHours: number;
  /** Bounded retry on transient (rate_limit/server) Sendblue errors. Default `3`. */
  transientRetryMaxAttempts: number;
  /** Base delay for transient backoff. Default `1000`ms — schedule is 1s/4s/16s. */
  transientRetryBaseMs: number;
  /** Cap on transient backoff. Default `60000`ms — keeps the queue from stalling forever. */
  transientRetryMaxMs: number;
  /**
   * SMS_LIMIT_REACHED stall retry interval. Sendblue does not document the
   * exact reset boundary; default `3600000`ms (1h) and re-attempt up to
   * `smsLimitMaxAttempts` times.
   */
  smsLimitRetryIntervalMs: number;
  smsLimitMaxAttempts: number;
  /**
   * Optional bearer token for the `/admin/limits` route. When unset the
   * route is **not mounted** at all, preventing accidental exposure of the
   * counter snapshot in misconfigured deploys.
   */
  adminApiToken?: string;
  /** Hard cap on label combinations stored per metric before overflowing into a sentinel series. */
  metricsLabelCardinalityLimit: number;
  /** Timeout (ms) on the Redis ping issued by `/ready`. */
  readyRedisTimeoutMs: number;
};

export type ConfigEnv = Record<string, string | undefined>;

function requireEnv(env: ConfigEnv, name: string): string {
  const value = env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

// E.164 — leading `+`, then 10–15 digits. Catches the silent ++<digits> typo
// that survives `requireEnv` and only surfaces when Sendblue rejects the call.
const E164 = /^\+\d{10,15}$/;
function requireE164Env(env: ConfigEnv, name: string): string {
  const value = requireEnv(env, name).trim();
  if (!E164.test(value)) {
    throw new Error(
      `Invalid E.164 phone number for ${name}: ${value}. Expected leading "+" followed by 10-15 digits (e.g. +15551234567).`
    );
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

/**
 * Like {@link optionalInt} but enforces `parsed >= min`. Used for env vars
 * where a `0` would produce nonsensical or destructive behavior — e.g.
 * `SENDBLUE_CONTACTS_DEDUPE_TTL_SECONDS=0` would either reject the Redis
 * `EX 0` SET or expire-on-set in memory, defeating dedupe.
 */
function optionalIntMin(env: ConfigEnv, name: string, fallback: number, min: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min) {
    throw new Error(`Invalid integer environment variable ${name}: must be >= ${min}`);
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
  const config = loadConfigInternal(env);
  validateConfig(config);
  return config;
}

/**
 * Cross-field config sanity checks. A misconfigured threshold (e.g.
 * `WARN > LIMIT`) silently swallows the warn-log emission, so we fail fast
 * at boot rather than discovering it operationally. Mirrors the load-bearing
 * relationships documented in `docs/features/plan-limits.md`.
 */
function validateConfig(config: AgentConfig): void {
  const requireLte = (
    aName: string,
    aValue: number,
    bName: string,
    bValue: number
  ): void => {
    if (aValue > bValue) {
      throw new Error(
        `Invalid config: ${aName}=${aValue} must be <= ${bName}=${bValue}`
      );
    }
  };
  requireLte(
    'INBOUND_CONTACTS_PER_DAY_WARN_THRESHOLD',
    config.inboundContactsPerDayWarnThreshold,
    'INBOUND_CONTACTS_PER_DAY_LIMIT',
    config.inboundContactsPerDayLimit
  );
  requireLte(
    'FOLLOW_UP_DAILY_WARN_THRESHOLD',
    config.followUpDailyWarnThreshold,
    'FOLLOW_UP_DAILY_LIMIT',
    config.followUpDailyLimit
  );
  requireLte(
    'OUTBOUND_RATE_LIMIT_PER_HOUR',
    config.outboundRateLimitPerHour,
    'OUTBOUND_RATE_LIMIT_PER_DAY',
    config.outboundRateLimitPerDay
  );
  requireLte(
    'TRANSIENT_RETRY_BASE_MS',
    config.transientRetryBaseMs,
    'TRANSIENT_RETRY_MAX_MS',
    config.transientRetryMaxMs
  );
}

function loadConfigInternal(env: ConfigEnv): AgentConfig {
  return {
    port: optionalInt(env, 'PORT', 3000),
    publicBaseUrl: requireEnv(env, 'PUBLIC_BASE_URL').replace(/\/+$/, ''),
    chatEndpointUrl: requireEnv(env, 'CHAT_ENDPOINT_URL'),
    sendblueApiKeyId: requireEnv(env, 'SENDBLUE_API_KEY_ID'),
    sendblueApiSecretKey: requireEnv(env, 'SENDBLUE_API_SECRET_KEY'),
    sendblueApiBaseUrl: (env.SENDBLUE_API_BASE_URL || 'https://api.sendblue.co').replace(/\/+$/, ''),
    sendblueApiV2BaseUrl: (env.SENDBLUE_API_V2_BASE_URL || 'https://api.sendblue.com').replace(/\/+$/, ''),
    sendblueFromNumber: requireE164Env(env, 'SENDBLUE_FROM_NUMBER'),
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
    identityResolverTimeoutMs: optionalInt(env, 'IDENTITY_RESOLVER_TIMEOUT_MS', 5000),
    outboundTypingIndicatorsEnabled: optionalBoolean(env, 'OUTBOUND_TYPING_INDICATORS_ENABLED', true),
    inboundTypingStateEnabled: optionalBoolean(env, 'INBOUND_TYPING_STATE_ENABLED', true),
    readReceiptsEnabled: optionalBoolean(env, 'READ_RECEIPTS_ENABLED', false),
    readReceiptDebounceMs: optionalInt(env, 'READ_RECEIPT_DEBOUNCE_MS', 250),
    typingStartDelayMs: optionalInt(env, 'TYPING_START_DELAY_MS', 500),
    typingRefreshIntervalMs: optionalInt(env, 'TYPING_REFRESH_INTERVAL_MS', 5000),
    typingRefreshMaxMs: optionalInt(env, 'TYPING_REFRESH_MAX_MS', 120000),
    agentDisplayName: optionalString(env, 'AGENT_DISPLAY_NAME') ?? 'sb-agent',
    validUserRequired: optionalBoolean(env, 'VALID_USER_REQUIRED', false),
    groupInvocationContentFallback: optionalBoolean(env, 'GROUP_INVOCATION_CONTENT_FALLBACK', true),
    chatResponseParseTags: optionalBoolean(env, 'CHAT_RESPONSE_PARSE_TAGS', true),
    chatResponseTags: {
      message: optionalTagName(env, 'CHAT_RESPONSE_MESSAGE_TAG', DEFAULT_CHAT_RESPONSE_TAGS.message),
      noResponse: optionalTagName(env, 'CHAT_RESPONSE_NO_RESPONSE_TAG', DEFAULT_CHAT_RESPONSE_TAGS.noResponse),
      reaction: optionalTagName(env, 'CHAT_RESPONSE_REACTION_TAG', DEFAULT_CHAT_RESPONSE_TAGS.reaction),
      reply: optionalTagName(env, 'CHAT_RESPONSE_REPLY_TAG', DEFAULT_CHAT_RESPONSE_TAGS.reply)
    },
    sendblueContactsEnabled: optionalBoolean(env, 'SENDBLUE_CONTACTS_ENABLED', false),
    sendblueContactsDefaultTags: optionalCsv(env, 'SENDBLUE_CONTACTS_DEFAULT_TAGS'),
    sendblueContactsDedupeTtlSeconds: optionalIntMin(env, 'SENDBLUE_CONTACTS_DEDUPE_TTL_SECONDS', 2592000, 1),
    outboundRateLimitPerSecond: optionalInt(env, 'OUTBOUND_RATE_LIMIT_PER_SECOND', 1),
    outboundRateLimitPerHour: optionalInt(env, 'OUTBOUND_RATE_LIMIT_PER_HOUR', 2000),
    outboundRateLimitPerDay: optionalInt(env, 'OUTBOUND_RATE_LIMIT_PER_DAY', 4000),
    inboundContactsPerDayWarnThreshold: optionalInt(env, 'INBOUND_CONTACTS_PER_DAY_WARN_THRESHOLD', 800),
    inboundContactsPerDayLimit: optionalInt(env, 'INBOUND_CONTACTS_PER_DAY_LIMIT', 1000),
    followUpDailyWarnThreshold: optionalInt(env, 'FOLLOW_UP_DAILY_WARN_THRESHOLD', 160),
    followUpDailyLimit: optionalInt(env, 'FOLLOW_UP_DAILY_LIMIT', 200),
    replyWindowHours: optionalInt(env, 'REPLY_WINDOW_HOURS', 24),
    transientRetryMaxAttempts: optionalInt(env, 'TRANSIENT_RETRY_MAX_ATTEMPTS', 3),
    transientRetryBaseMs: optionalInt(env, 'TRANSIENT_RETRY_BASE_MS', 1000),
    transientRetryMaxMs: optionalInt(env, 'TRANSIENT_RETRY_MAX_MS', 60000),
    smsLimitRetryIntervalMs: optionalIntMin(env, 'SMS_LIMIT_RETRY_INTERVAL_MS', 3600000, 1),
    smsLimitMaxAttempts: optionalIntMin(env, 'SMS_LIMIT_MAX_ATTEMPTS', 24, 1),
    adminApiToken: optionalString(env, 'ADMIN_API_TOKEN'),
    metricsLabelCardinalityLimit: optionalInt(env, 'METRICS_LABEL_CARDINALITY_LIMIT', 1000),
    readyRedisTimeoutMs: optionalInt(env, 'READY_REDIS_TIMEOUT_MS', 500)
  };
}

function optionalCsv(env: ConfigEnv, name: string): string[] {
  const raw = env[name];
  if (!raw) return [];
  return raw
    .split(',')
    .map(value => value.trim())
    .filter(value => value.length > 0);
}
