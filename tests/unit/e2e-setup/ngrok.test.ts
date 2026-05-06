import { describe, expect, it, vi } from 'vitest';
import {
  buildNgrokConfig,
  normalizeNgrokUrl,
  startNgrokTunnel
} from '../../../scripts/e2e/lib/ngrok.js';
import { readSetupEnv } from '../../../scripts/e2e/lib/env.js';

describe('ngrok helpers', () => {
  it('builds SDK config from env without requiring a global CLI', () => {
    const env = readSetupEnv(
      {
        E2E_AGENT_PORT: '3456',
        NGROK_AUTHTOKEN: 'token',
        NGROK_DOMAIN: 'agent.example.ngrok.app',
        SENDBLUE_API_KEY_ID: 'key',
        SENDBLUE_API_SECRET_KEY: 'secret',
        SENDBLUE_FROM_NUMBER: '+15552220000'
      },
      { includeFiles: false }
    );

    expect(buildNgrokConfig(env)).toEqual({
      addr: 3456,
      authtoken: 'token',
      domain: 'agent.example.ngrok.app'
    });
  });

  it('omits domain when no reserved domain is configured', () => {
    const env = readSetupEnv(
      {
        NGROK_AUTHTOKEN: 'token',
        SENDBLUE_API_KEY_ID: 'key',
        SENDBLUE_API_SECRET_KEY: 'secret',
        SENDBLUE_FROM_NUMBER: '+15552220000'
      },
      { includeFiles: false }
    );

    expect(buildNgrokConfig(env)).toEqual({ addr: 3000, authtoken: 'token' });
  });

  it('starts and closes an SDK tunnel through an injected forwarder', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const forward = vi.fn().mockResolvedValue({
      url: () => 'https://abc.ngrok-free.app/',
      close
    });
    const env = readSetupEnv(
      {
        E2E_AGENT_PORT: '3456',
        NGROK_AUTHTOKEN: 'token',
        SENDBLUE_API_KEY_ID: 'key',
        SENDBLUE_API_SECRET_KEY: 'secret',
        SENDBLUE_FROM_NUMBER: '+15552220000'
      },
      { includeFiles: false }
    );

    const tunnel = await startNgrokTunnel(env, forward);

    expect(forward).toHaveBeenCalledWith({ addr: 3456, authtoken: 'token' });
    expect(tunnel.publicUrl).toBe('https://abc.ngrok-free.app');

    await tunnel.close();
    expect(close).toHaveBeenCalled();
  });

  it('rejects non-HTTPS listener URLs', () => {
    expect(normalizeNgrokUrl('http://abc.ngrok-free.app')).toBeUndefined();
    expect(normalizeNgrokUrl(null)).toBeUndefined();
  });
});
