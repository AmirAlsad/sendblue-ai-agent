import { readSetupEnv } from '../../../scripts/e2e/lib/env.js';
import { resolveMessagesDbPath } from '../../../scripts/e2e/lib/messages.js';

export type E2EEnv = {
  publicBaseUrl?: string;
  agentPort: number;
  ngrokAuthtoken?: string;
  ngrokDomain?: string;
  sendblueApiKeyId: string;
  sendblueApiSecretKey: string;
  sendblueApiBaseUrl: string;
  sendblueFromNumber: string;
  sendblueWebhookSecret?: string;
  sendblueWebhookSecretHeader: string;
  testDeviceNumber: string;
  messagesDbPath: string;
};

export function loadE2EEnv(): E2EEnv {
  const env = readSetupEnv();
  const required = requiredE2EEnv(env);

  return {
    publicBaseUrl: env.e2ePublicBaseUrl,
    agentPort: env.agentPort,
    ngrokAuthtoken: env.ngrokAuthtoken,
    ngrokDomain: env.ngrokDomain,
    sendblueApiBaseUrl: env.sendblueApiBaseUrl,
    sendblueApiKeyId: required.sendblueApiKeyId,
    sendblueApiSecretKey: required.sendblueApiSecretKey,
    sendblueFromNumber: required.sendblueFromNumber,
    sendblueWebhookSecret: env.sendblueWebhookSecret,
    sendblueWebhookSecretHeader: env.sendblueWebhookSecretHeader,
    testDeviceNumber: required.testDeviceNumber,
    messagesDbPath: resolveMessagesDbPath(env.messagesDbPath)
  };
}

function requiredE2EEnv(env: ReturnType<typeof readSetupEnv>) {
  const values = {
    sendblueApiKeyId: env.sendblueApiKeyId,
    sendblueApiSecretKey: env.sendblueApiSecretKey,
    sendblueFromNumber: env.sendblueFromNumber,
    testDeviceNumber: env.testDeviceNumber
  };
  const missing = Object.entries(values)
    .filter(([, value]) => !value)
    .map(([key]) => e2eEnvNames[key as keyof typeof values]);

  if (missing.length > 0) {
    throw new Error(`Missing required E2E environment variables: ${missing.join(', ')}`);
  }

  if (!env.e2ePublicBaseUrl && !env.ngrokAuthtoken) {
    throw new Error('Missing required E2E environment variable: NGROK_AUTHTOKEN');
  }

  return values as { [K in keyof typeof values]: string };
}

const e2eEnvNames = {
  sendblueApiKeyId: 'SENDBLUE_API_KEY_ID',
  sendblueApiSecretKey: 'SENDBLUE_API_SECRET_KEY',
  sendblueFromNumber: 'SENDBLUE_FROM_NUMBER',
  testDeviceNumber: 'E2E_TEST_DEVICE_NUMBER'
};
