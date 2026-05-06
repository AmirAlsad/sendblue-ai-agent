export type AgentConfig = {
  port: number;
  publicBaseUrl: string;
  chatEndpointUrl: string;
  sendblueApiKeyId: string;
  sendblueApiSecretKey: string;
  sendblueApiBaseUrl: string;
  sendblueFromNumber: string;
  sendblueWebhookSecret?: string;
  sendblueWebhookSecretHeader: string;
  chatEndpointTimeoutMs: number;
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

export function loadConfig(env: ConfigEnv = process.env): AgentConfig {
  return {
    port: optionalInt(env, 'PORT', 3000),
    publicBaseUrl: requireEnv(env, 'PUBLIC_BASE_URL').replace(/\/+$/, ''),
    chatEndpointUrl: requireEnv(env, 'CHAT_ENDPOINT_URL'),
    sendblueApiKeyId: requireEnv(env, 'SENDBLUE_API_KEY_ID'),
    sendblueApiSecretKey: requireEnv(env, 'SENDBLUE_API_SECRET_KEY'),
    sendblueApiBaseUrl: (env.SENDBLUE_API_BASE_URL || 'https://api.sendblue.co').replace(/\/+$/, ''),
    sendblueFromNumber: requireEnv(env, 'SENDBLUE_FROM_NUMBER'),
    sendblueWebhookSecret: env.SENDBLUE_WEBHOOK_SECRET || undefined,
    sendblueWebhookSecretHeader:
      env.SENDBLUE_WEBHOOK_SECRET_HEADER || 'x-sendblue-webhook-secret',
    chatEndpointTimeoutMs: optionalInt(env, 'CHAT_ENDPOINT_TIMEOUT_MS', 10000)
  };
}
