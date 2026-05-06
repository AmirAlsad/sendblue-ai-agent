import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import dotenv from 'dotenv';

export type E2ESetupEnv = {
  agentPort: number;
  publicBaseUrl?: string;
  ngrokAuthtoken?: string;
  ngrokDomain?: string;
  ngrokBin: string;
  ngrokApiUrl: string;
  sendblueApiBaseUrl: string;
  sendblueApiKeyId?: string;
  sendblueApiSecretKey?: string;
  sendblueFromNumber?: string;
  sendblueWebhookSecret?: string;
  sendblueWebhookSecretHeader: string;
  sendblueNumber?: string;
  testDeviceNumber?: string;
  messagesDbPath: string;
};

export type ValidationMode = 'setup' | 'verify' | 'dev' | 'sendblue-webhooks';

export const ENV_FILE = '.env.e2e';

export function loadDotenvFiles(cwd = process.cwd()): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const file of ['.env', ENV_FILE]) {
    const path = resolve(cwd, file);
    if (existsSync(path)) {
      Object.assign(merged, dotenv.parse(readFileSync(path)));
    }
  }
  return merged;
}

export function readSetupEnv(
  overrides: Record<string, string | undefined> = process.env,
  options: { includeFiles?: boolean } = {}
): E2ESetupEnv {
  const fileEnv = options.includeFiles === false ? {} : loadDotenvFiles();
  const env = { ...fileEnv, ...overrides };
  const publicBaseUrl = env.E2E_PUBLIC_BASE_URL || env.PUBLIC_BASE_URL || undefined;

  return {
    agentPort: intValue(env.E2E_AGENT_PORT || env.PORT, 3000, 'E2E_AGENT_PORT'),
    publicBaseUrl: publicBaseUrl?.replace(/\/+$/, ''),
    ngrokAuthtoken: env.NGROK_AUTHTOKEN || undefined,
    ngrokDomain: env.NGROK_DOMAIN || undefined,
    ngrokBin: env.NGROK_BIN || 'ngrok',
    ngrokApiUrl: (env.NGROK_API_URL || 'http://127.0.0.1:4040').replace(/\/+$/, ''),
    sendblueApiBaseUrl: (env.SENDBLUE_API_BASE_URL || 'https://api.sendblue.co').replace(/\/+$/, ''),
    sendblueApiKeyId: env.SENDBLUE_API_KEY_ID || undefined,
    sendblueApiSecretKey: env.SENDBLUE_API_SECRET_KEY || undefined,
    sendblueFromNumber: env.SENDBLUE_FROM_NUMBER || undefined,
    sendblueWebhookSecret: env.SENDBLUE_WEBHOOK_SECRET || undefined,
    sendblueWebhookSecretHeader: env.SENDBLUE_WEBHOOK_SECRET_HEADER || 'x-sendblue-webhook-secret',
    sendblueNumber: env.E2E_SENDBLUE_NUMBER || undefined,
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
    required.push('sendblueNumber', 'testDeviceNumber');
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
  return `# Local real-device E2E configuration. This file is gitignored.
E2E_AGENT_PORT=3000
E2E_PUBLIC_BASE_URL=

SENDBLUE_API_BASE_URL=https://api.sendblue.co
SENDBLUE_API_KEY_ID=
SENDBLUE_API_SECRET_KEY=
SENDBLUE_FROM_NUMBER=
SENDBLUE_WEBHOOK_SECRET=
SENDBLUE_WEBHOOK_SECRET_HEADER=x-sendblue-webhook-secret

E2E_SENDBLUE_NUMBER=
E2E_TEST_DEVICE_NUMBER=
E2E_MESSAGES_DB_PATH=~/Library/Messages/chat.db

NGROK_BIN=ngrok
NGROK_AUTHTOKEN=
NGROK_DOMAIN=
NGROK_API_URL=http://127.0.0.1:4040
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
    E2E_SENDBLUE_NUMBER: env.sendblueNumber ?? '',
    E2E_TEST_DEVICE_NUMBER: env.testDeviceNumber ?? '',
    E2E_MESSAGES_DB_PATH: env.messagesDbPath
  };
}

const envNameForKey: Record<keyof E2ESetupEnv, string> = {
  agentPort: 'E2E_AGENT_PORT',
  publicBaseUrl: 'E2E_PUBLIC_BASE_URL',
  ngrokAuthtoken: 'NGROK_AUTHTOKEN',
  ngrokDomain: 'NGROK_DOMAIN',
  ngrokBin: 'NGROK_BIN',
  ngrokApiUrl: 'NGROK_API_URL',
  sendblueApiBaseUrl: 'SENDBLUE_API_BASE_URL',
  sendblueApiKeyId: 'SENDBLUE_API_KEY_ID',
  sendblueApiSecretKey: 'SENDBLUE_API_SECRET_KEY',
  sendblueFromNumber: 'SENDBLUE_FROM_NUMBER',
  sendblueWebhookSecret: 'SENDBLUE_WEBHOOK_SECRET',
  sendblueWebhookSecretHeader: 'SENDBLUE_WEBHOOK_SECRET_HEADER',
  sendblueNumber: 'E2E_SENDBLUE_NUMBER',
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
