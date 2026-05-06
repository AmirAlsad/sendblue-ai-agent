import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpSendblueClient } from '../../src/sendblue/client.js';
import { testConfig } from '../helpers/config.js';

describe('HttpSendblueClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends required Sendblue credentials and per-message status_callback', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message_handle: 'outbound-001' })
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new HttpSendblueClient(testConfig());
    const result = await client.sendMessage({
      toNumber: '+15551110001',
      content: 'hello back',
      statusCallback: 'https://agent.example.test/webhook/status'
    });

    expect(result.messageHandle).toBe('outbound-001');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.sendblue.example.test/api/send-message',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'sb-api-key-id': 'test-key-id',
          'sb-api-secret-key': 'test-secret-key'
        }),
        body: JSON.stringify({
          number: '+15551110001',
          from_number: '+15552220000',
          content: 'hello back',
          status_callback: 'https://agent.example.test/webhook/status'
        })
      })
    );
  });

  it('rejects sends without status_callback', async () => {
    const client = new HttpSendblueClient(testConfig());

    await expect(
      client.sendMessage({
        toNumber: '+15551110001',
        content: 'hello back',
        statusCallback: ''
      })
    ).rejects.toThrow(/status_callback/);
  });

  it('sends typing indicators with Sendblue credentials', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'SENT', error_message: null })
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new HttpSendblueClient(testConfig());
    await expect(client.sendTypingIndicator({ toNumber: '+15551110001' })).resolves.toMatchObject({
      status: 'SENT',
      errorMessage: null
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.sendblue.example.test/api/send-typing-indicator',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'sb-api-key-id': 'test-key-id',
          'sb-api-secret-key': 'test-secret-key'
        }),
        body: JSON.stringify({
          number: '+15551110001',
          from_number: '+15552220000'
        })
      })
    );
  });
});
