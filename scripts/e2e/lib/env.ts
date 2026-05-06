import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import dotenv from 'dotenv';

export type E2ESetupEnv = {
  agentPort: number;
  publicBaseUrl?: string;
  e2ePublicBaseUrl?: string;
  ngrokAuthtoken?: string;
  ngrokDomain?: string;
  sendblueApiBaseUrl: string;
  sendblueApiKeyId?: string;
  sendblueApiSecretKey?: string;
  sendblueFromNumber?: string;
  sendblueWebhookSecret?: string;
  sendblueWebhookSecretHeader: string;
  testDeviceNumber?: string;
  messagesDbPath: string;
};

export type ValidationMode = 'setup' | 'verify' | 'dev' | 'sendblue-webhooks' | 'capture';

export const ENV_FILE = '.env';

export function loadDotenvFiles(cwd = process.cwd()): Record<string, string> {
  const path = resolve(cwd, ENV_FILE);
  return existsSync(path) ? dotenv.parse(readFileSync(path)) : {};
}

export function readSetupEnv(
  overrides: Record<string, string | undefined> = process.env,
  options: { includeFiles?: boolean } = {}
): E2ESetupEnv {
  const fileEnv = options.includeFiles === false ? {} : loadDotenvFiles();
  const env = { ...fileEnv, ...overrides };
  const e2ePublicBaseUrl = env.E2E_PUBLIC_BASE_URL || undefined;
  const publicBaseUrl = e2ePublicBaseUrl || env.PUBLIC_BASE_URL || undefined;

  return {
    agentPort: intValue(env.E2E_AGENT_PORT || env.PORT, 3000, 'E2E_AGENT_PORT'),
    publicBaseUrl: publicBaseUrl?.replace(/\/+$/, ''),
    e2ePublicBaseUrl: e2ePublicBaseUrl?.replace(/\/+$/, ''),
    ngrokAuthtoken: env.NGROK_AUTHTOKEN || undefined,
    ngrokDomain: env.NGROK_DOMAIN || undefined,
    sendblueApiBaseUrl: (env.SENDBLUE_API_BASE_URL || 'https://api.sendblue.co').replace(/\/+$/, ''),
    sendblueApiKeyId: env.SENDBLUE_API_KEY_ID || undefined,
    sendblueApiSecretKey: env.SENDBLUE_API_SECRET_KEY || undefined,
    sendblueFromNumber: env.SENDBLUE_FROM_NUMBER || undefined,
    sendblueWebhookSecret: env.SENDBLUE_WEBHOOK_SECRET || undefined,
    sendblueWebhookSecretHeader: env.SENDBLUE_WEBHOOK_SECRET_HEADER || 'sb-signing-secret',
    testDeviceNumber: env.E2E_TEST_DEVICE_NUMBER || undefined,
    messagesDbPath: env.E2E_MESSAGES_DB_PATH || '~/Library/Messages/chat.db'
  };
}

export function missingEnv(env: E2ESetupEnv, mode: ValidationMode): string[] {
  const required: Array<keyof E2ESetupEnv> = [
    'sendblueApiKeyId',
    'sendblueApiSecretKey',
    'sendblueFromNumber'
  ];

  if (mode === 'verify') {
    required.push('testDeviceNumber');
    if (!env.e2ePublicBaseUrl) {
      required.push('ngrokAuthtoken');
    }
  }

  if (mode === 'capture') {
    required.push('testDeviceNumber');
    if (!env.e2ePublicBaseUrl) {
      required.push('ngrokAuthtoken');
    }
  }

  if (mode === 'dev') {
    required.push('ngrokAuthtoken');
  }

  if (mode === 'sendblue-webhooks') {
    required.push('publicBaseUrl');
  }

  return required
    .filter(key => !env[key])
    .map(key => envNameForKey[key]);
}

export function assertEnv(env: E2ESetupEnv, mode: ValidationMode): void {
  const missing = missingEnv(env, mode);
  if (missing.length > 0) {
    throw new Error(`Missing required ${mode} environment variables: ${missing.join(', ')}`);
  }
}

export function e2eEnvTemplate(): string {
  return `# sendblue-ai-agent local configuration.
#
# This .env file is gitignored. Do not commit Sendblue credentials, webhook
# secrets, ngrok tokens, phone numbers, or captured real message content.

# Agent server.
# PORT is optional and defaults to 3000.
# PUBLIC_BASE_URL is required for normal dev/start and is used for status_callback URLs.
# CHAT_ENDPOINT_URL is required for normal dev/start. dev:e2e starts its own endpoint.
PORT=3000
PUBLIC_BASE_URL=
CHAT_ENDPOINT_URL=
CHAT_ENDPOINT_TIMEOUT_MS=10000

# Real-device E2E.
# E2E_AGENT_PORT is optional and defaults to PORT, then 3000.
# E2E_PUBLIC_BASE_URL is optional; leave blank to let the repo start ngrok.
E2E_AGENT_PORT=3000
E2E_PUBLIC_BASE_URL=

# Sendblue API.
# API credentials and from number are required for agent sends and E2E tooling.
# Webhook secret values are optional. Sendblue documents sb-signing-secret for
# secret delivery; keep captured real webhooks as fixtures before production use.
SENDBLUE_API_BASE_URL=https://api.sendblue.co
SENDBLUE_API_KEY_ID=
SENDBLUE_API_SECRET_KEY=
SENDBLUE_FROM_NUMBER=
SENDBLUE_WEBHOOK_SECRET=
SENDBLUE_WEBHOOK_SECRET_HEADER=sb-signing-secret

# Real-device E2E participants.
# test:e2e sends to SENDBLUE_FROM_NUMBER.
# E2E_MESSAGES_DB_PATH is optional and defaults to ~/Library/Messages/chat.db.
E2E_TEST_DEVICE_NUMBER=
E2E_MESSAGES_DB_PATH=~/Library/Messages/chat.db

# ngrok SDK tunnel.
# NGROK_AUTHTOKEN is required for dev:e2e and for test:e2e unless E2E_PUBLIC_BASE_URL is set.
# NGROK_DOMAIN is optional; leave blank for a generated URL.
NGROK_AUTHTOKEN=
NGROK_DOMAIN=

# Optional live showcase settings.
# SHOWCASE_MEDIA_URL should be a public HTTPS asset if you want npm run showcase:e2e
# to send hosted media during the outbound media step.
SHOWCASE_MEDIA_URL=
SHOWCASE_READ_TYPING_DELAY_MS=15000
SHOWCASE_CHAT_ENDPOINT_TIMEOUT_MS=30000
SHOWCASE_BUFFER_BASE_TIMEOUT_MS=10000
SHOWCASE_BUFFER_GROWTH_FACTOR=1.35
SHOWCASE_BUFFER_MAX_TIMEOUT_MS=15000
SHOWCASE_BUFFER_NOISE_MAX_DEVIATION=0
SHOWCASE_TYPING_REFRESH_INTERVAL_MS=1500
SHOWCASE_TYPING_REFRESH_MAX_MS=25000
`;
}

export function ensureEnvFile(cwd = process.cwd()): { path: string; created: boolean } {
  const path = resolve(cwd, ENV_FILE);
  if (existsSync(path)) return { path, created: false };
  writeFileSync(path, e2eEnvTemplate(), { mode: 0o600 });
  return { path, created: true };
}

export function mergeRuntimeEnv(env: E2ESetupEnv, publicBaseUrl: string, chatEndpointUrl: string) {
  return {
    ...process.env,
    NODE_ENV: 'development',
    AGENT_AUTOSTART: '0',
    PORT: String(env.agentPort),
    PUBLIC_BASE_URL: publicBaseUrl,
    E2E_PUBLIC_BASE_URL: publicBaseUrl,
    CHAT_ENDPOINT_URL: chatEndpointUrl,
    SENDBLUE_API_BASE_URL: env.sendblueApiBaseUrl,
    SENDBLUE_API_KEY_ID: env.sendblueApiKeyId ?? '',
    SENDBLUE_API_SECRET_KEY: env.sendblueApiSecretKey ?? '',
    SENDBLUE_FROM_NUMBER: env.sendblueFromNumber ?? '',
    SENDBLUE_WEBHOOK_SECRET: env.sendblueWebhookSecret ?? '',
    SENDBLUE_WEBHOOK_SECRET_HEADER: env.sendblueWebhookSecretHeader,
    E2E_AGENT_PORT: String(env.agentPort),
    E2E_TEST_DEVICE_NUMBER: env.testDeviceNumber ?? '',
    E2E_MESSAGES_DB_PATH: env.messagesDbPath
  };
}

const envNameForKey: Record<keyof E2ESetupEnv, string> = {
  agentPort: 'E2E_AGENT_PORT',
  publicBaseUrl: 'E2E_PUBLIC_BASE_URL',
  e2ePublicBaseUrl: 'E2E_PUBLIC_BASE_URL',
  ngrokAuthtoken: 'NGROK_AUTHTOKEN',
  ngrokDomain: 'NGROK_DOMAIN',
  sendblueApiBaseUrl: 'SENDBLUE_API_BASE_URL',
  sendblueApiKeyId: 'SENDBLUE_API_KEY_ID',
  sendblueApiSecretKey: 'SENDBLUE_API_SECRET_KEY',
  sendblueFromNumber: 'SENDBLUE_FROM_NUMBER',
  sendblueWebhookSecret: 'SENDBLUE_WEBHOOK_SECRET',
  sendblueWebhookSecretHeader: 'SENDBLUE_WEBHOOK_SECRET_HEADER',
  testDeviceNumber: 'E2E_TEST_DEVICE_NUMBER',
  messagesDbPath: 'E2E_MESSAGES_DB_PATH'
};

function intValue(raw: string | undefined, fallback: number, name: string): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid integer ${name}: ${raw}`);
  }
  return parsed;
}
