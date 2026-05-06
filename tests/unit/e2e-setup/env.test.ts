import { describe, expect, it } from 'vitest';
import { missingEnv, readSetupEnv } from '../../../scripts/e2e/lib/env.js';

describe('E2E setup env', () => {
  it('loads defaults and maps public URL aliases', () => {
    const env = readSetupEnv(
      {
        PUBLIC_BASE_URL: 'https://agent.example.test/',
        SENDBLUE_API_KEY_ID: 'key',
        SENDBLUE_API_SECRET_KEY: 'secret',
        SENDBLUE_FROM_NUMBER: '+15552220000'
      },
      { includeFiles: false }
    );

    expect(env).toMatchObject({
      agentPort: 3000,
      publicBaseUrl: 'https://agent.example.test',
      ngrokBin: 'ngrok',
      ngrokApiUrl: 'http://127.0.0.1:4040',
      sendblueApiBaseUrl: 'https://api.sendblue.co',
      sendblueWebhookSecretHeader: 'x-sendblue-webhook-secret',
      messagesDbPath: '~/Library/Messages/chat.db'
    });
  });

  it('reports mode-specific missing variables', () => {
    const env = readSetupEnv({}, { includeFiles: false });

    expect(missingEnv(env, 'sendblue-webhooks')).toContain('E2E_PUBLIC_BASE_URL');
    expect(missingEnv(env, 'verify')).toEqual(
      expect.arrayContaining([
        'SENDBLUE_API_KEY_ID',
        'SENDBLUE_API_SECRET_KEY',
        'SENDBLUE_FROM_NUMBER',
        'E2E_SENDBLUE_NUMBER',
        'E2E_TEST_DEVICE_NUMBER'
      ])
    );
    expect(missingEnv(env, 'dev')).not.toContain('E2E_TEST_DEVICE_NUMBER');
  });
});
