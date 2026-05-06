import { readSetupEnv } from '../../../scripts/e2e/lib/env.js';
import { resolveMessagesDbPath } from '../../../scripts/e2e/lib/messages.js';

export type E2EEnv = {
  publicBaseUrl: string;
  agentPort: number;
  sendblueApiKeyId: string;
  sendblueApiSecretKey: string;
  sendblueApiBaseUrl: string;
  sendblueFromNumber: string;
  sendblueWebhookSecret?: string;
  sendblueWebhookSecretHeader: string;
  sendblueNumber: string;
  testDeviceNumber: string;
  messagesDbPath: string;
};

export function loadE2EEnv(): E2EEnv {
  const env = readSetupEnv();
  const required = requiredE2EEnv(env);

  return {
    publicBaseUrl: required.publicBaseUrl,
    agentPort: env.agentPort,
    sendblueApiBaseUrl: env.sendblueApiBaseUrl,
    sendblueApiKeyId: required.sendblueApiKeyId,
    sendblueApiSecretKey: required.sendblueApiSecretKey,
    sendblueFromNumber: required.sendblueFromNumber,
    sendblueWebhookSecret: env.sendblueWebhookSecret,
    sendblueWebhookSecretHeader: env.sendblueWebhookSecretHeader,
    sendblueNumber: required.sendblueNumber,
    testDeviceNumber: required.testDeviceNumber,
    messagesDbPath: resolveMessagesDbPath(env.messagesDbPath)
  };
}

function requiredE2EEnv(env: ReturnType<typeof readSetupEnv>) {
  const values = {
    publicBaseUrl: env.publicBaseUrl,
    sendblueApiKeyId: env.sendblueApiKeyId,
    sendblueApiSecretKey: env.sendblueApiSecretKey,
    sendblueFromNumber: env.sendblueFromNumber,
    sendblueNumber: env.sendblueNumber,
    testDeviceNumber: env.testDeviceNumber
  };
  const missing = Object.entries(values)
    .filter(([, value]) => !value)
    .map(([key]) => e2eEnvNames[key as keyof typeof values]);

  if (missing.length > 0) {
    throw new Error(`Missing required E2E environment variables: ${missing.join(', ')}`);
  }

  return values as { [K in keyof typeof values]: string };
}

const e2eEnvNames = {
  publicBaseUrl: 'E2E_PUBLIC_BASE_URL',
  sendblueApiKeyId: 'SENDBLUE_API_KEY_ID',
  sendblueApiSecretKey: 'SENDBLUE_API_SECRET_KEY',
  sendblueFromNumber: 'SENDBLUE_FROM_NUMBER',
  sendblueNumber: 'E2E_SENDBLUE_NUMBER',
  testDeviceNumber: 'E2E_TEST_DEVICE_NUMBER'
};
