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
      sendblueApiBaseUrl: 'https://api.sendblue.co',
      sendblueWebhookSecretHeader: 'sb-signing-secret',
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
        'NGROK_AUTHTOKEN',
        'E2E_TEST_DEVICE_NUMBER'
      ])
    );
    expect(missingEnv(env, 'dev')).toContain('NGROK_AUTHTOKEN');
    expect(missingEnv(env, 'dev')).not.toContain('E2E_TEST_DEVICE_NUMBER');
    expect(missingEnv(env, 'capture')).toEqual(expect.arrayContaining(['NGROK_AUTHTOKEN', 'E2E_TEST_DEVICE_NUMBER']));
  });

  it('does not require an ngrok token for verification or capture when an E2E public URL is provided', () => {
    const env = readSetupEnv(
      {
        E2E_PUBLIC_BASE_URL: 'https://external.example.test',
        SENDBLUE_API_KEY_ID: 'key',
        SENDBLUE_API_SECRET_KEY: 'secret',
        SENDBLUE_FROM_NUMBER: '+15552220000',
        E2E_TEST_DEVICE_NUMBER: '+15551110000'
      },
      { includeFiles: false }
    );

    expect(missingEnv(env, 'verify')).not.toContain('NGROK_AUTHTOKEN');
    expect(missingEnv(env, 'capture')).not.toContain('NGROK_AUTHTOKEN');
  });
});
