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

  it('passes direct hosted media and send effects through the Sendblue v1 send endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message_handle: 'outbound-media-001' })
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new HttpSendblueClient(testConfig());
    await client.sendMessage({
      toNumber: '+15551110001',
      content: 'photo',
      statusCallback: 'https://agent.example.test/webhook/status',
      mediaUrl: 'https://cdn.example.test/photo.png',
      sendStyle: 'celebration'
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.sendblue.example.test/api/send-message',
      expect.objectContaining({
        body: JSON.stringify({
          number: '+15551110001',
          from_number: '+15552220000',
          content: 'photo',
          status_callback: 'https://agent.example.test/webhook/status',
          media_url: 'https://cdn.example.test/photo.png',
          send_style: 'celebration'
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

  it('sends group messages with rich fields through the Sendblue v2 base URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message_handle: 'group-outbound-001' })
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new HttpSendblueClient(testConfig());
    const result = await client.sendGroupMessage({
      groupId: 'group-123',
      content: 'hello group',
      statusCallback: 'https://agent.example.test/webhook/status',
      mediaUrl: 'https://cdn.example.test/group.png',
      sendStyle: 'balloons'
    });

    expect(result.messageHandle).toBe('group-outbound-001');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api-v2.sendblue.example.test/api/send-group-message',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'sb-api-key-id': 'test-key-id',
          'sb-api-secret-key': 'test-secret-key'
        }),
        body: JSON.stringify({
          group_id: 'group-123',
          from_number: '+15552220000',
          content: 'hello group',
          status_callback: 'https://agent.example.test/webhook/status',
          media_url: 'https://cdn.example.test/group.png',
          send_style: 'balloons'
        })
      })
    );
  });

  it('sends reactions and read receipts through the Sendblue v2 base URL', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'OK',
          message: 'Reaction request sent',
          message_handle: 'inbound-001',
          reaction: 'love'
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'OK',
          message: 'Mark read request sent',
          number: '+15551110001'
        })
      });
    vi.stubGlobal('fetch', fetchMock);

    const client = new HttpSendblueClient(testConfig());
    await expect(
      client.sendReaction({ messageHandle: 'inbound-001', reaction: 'love', partIndex: 1 })
    ).resolves.toMatchObject({
      status: 'OK',
      messageHandle: 'inbound-001',
      reaction: 'love'
    });
    await expect(client.markRead({ toNumber: '+15551110001' })).resolves.toMatchObject({
      status: 'OK',
      number: '+15551110001'
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://api-v2.sendblue.example.test/api/send-reaction',
      expect.objectContaining({
        body: JSON.stringify({
          from_number: '+15552220000',
          message_handle: 'inbound-001',
          reaction: 'love',
          part_index: 1
        })
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://api-v2.sendblue.example.test/api/mark-read',
      expect.objectContaining({
        body: JSON.stringify({
          number: '+15551110001',
          from_number: '+15552220000'
        })
      })
    );
  });

  it('sends typing indicators with Sendblue credentials through the v2 base URL', async () => {
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
      'https://api-v2.sendblue.example.test/api/send-typing-indicator',
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

  it('normalizes Sendblue API errors across rich endpoint methods', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({
        status: 'ERROR',
        error_code: 'INVALID_REACTION',
        message: 'Invalid reaction'
      })
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new HttpSendblueClient(testConfig());
    await expect(
      client.sendReaction({ messageHandle: 'inbound-001', reaction: 'love' })
    ).rejects.toThrow(/Sendblue send-reaction failed with 400 \(INVALID_REACTION: Invalid reaction\)/);
  });
});
