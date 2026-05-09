import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpSendblueClient, SendblueApiError } from '../../src/sendblue/client.js';
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

  it('forwards optional seat_id on send-message for multi-seat attribution', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message_handle: 'outbound-seat-001' })
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new HttpSendblueClient(testConfig());
    await client.sendMessage({
      toNumber: '+15551110001',
      content: 'hi',
      statusCallback: 'https://agent.example.test/webhook/status',
      seatId: 'seat-uuid-abc-123'
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.sendblue.example.test/api/send-message',
      expect.objectContaining({
        body: JSON.stringify({
          number: '+15551110001',
          from_number: '+15552220000',
          content: 'hi',
          status_callback: 'https://agent.example.test/webhook/status',
          seat_id: 'seat-uuid-abc-123'
        })
      })
    );
  });

  it('omits seat_id from send-message when not provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message_handle: 'outbound-noseat-001' })
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new HttpSendblueClient(testConfig());
    await client.sendMessage({
      toNumber: '+15551110001',
      content: 'hi',
      statusCallback: 'https://agent.example.test/webhook/status'
    });

    const sendBody = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as Record<string, unknown>;
    expect(sendBody).not.toHaveProperty('seat_id');
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

  it('throws a structured SendblueApiError exposing httpStatus, errorCode, and the raw body', async () => {
    const responseBody = {
      status: 'ERROR',
      error_code: '5509',
      error_message: 'Rate limit window exceeded'
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => responseBody
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new HttpSendblueClient(testConfig());
    let thrown: unknown;
    try {
      await client.sendMessage({
        toNumber: '+15551110001',
        content: 'hello',
        statusCallback: 'https://agent.example.test/webhook/status'
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SendblueApiError);
    expect(thrown).toBeInstanceOf(Error);
    const apiError = thrown as SendblueApiError;
    expect(apiError.operation).toBe('send-message');
    expect(apiError.httpStatus).toBe(429);
    expect(apiError.errorCode).toBe('5509');
    expect(apiError.serverMessage).toBe('Rate limit window exceeded');
    expect(apiError.responseBody).toEqual(responseBody);
  });

  it('still throws SendblueApiError when the error response has no parseable body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error('not json');
      }
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new HttpSendblueClient(testConfig());
    let thrown: unknown;
    try {
      await client.markRead({ toNumber: '+15551110001' });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SendblueApiError);
    const apiError = thrown as SendblueApiError;
    expect(apiError.operation).toBe('mark-read');
    expect(apiError.httpStatus).toBe(502);
    expect(apiError.errorCode).toBeUndefined();
    expect(apiError.responseBody).toBeNull();
    expect(apiError.message).toMatch(/Sendblue mark-read failed with 502/);
  });

  it('omits status_callback on group sends when it is not provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message_handle: 'group-no-cb' })
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new HttpSendblueClient(testConfig());
    await client.sendGroupMessage({ groupId: 'group-123', content: 'hi' });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api-v2.sendblue.example.test/api/send-group-message',
      expect.objectContaining({
        body: JSON.stringify({
          group_id: 'group-123',
          from_number: '+15552220000',
          content: 'hi'
        })
      })
    );
  });

  it('routes send-message through the v1 base URL and rich endpoints through the v2 base URL', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ message_handle: 'v1-001' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ message_handle: 'v2-grp' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'OK', message_handle: 'rx' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'OK' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'QUEUED' }) });
    vi.stubGlobal('fetch', fetchMock);

    const client = new HttpSendblueClient(testConfig());
    await client.sendMessage({
      toNumber: '+15551110001',
      content: 'hi',
      statusCallback: 'https://agent.example.test/webhook/status'
    });
    await client.sendGroupMessage({ groupId: 'g', content: 'hi' });
    await client.sendReaction({ messageHandle: 'rx', reaction: 'love' });
    await client.markRead({ toNumber: '+15551110001' });
    await client.sendTypingIndicator({ toNumber: '+15551110001' });

    const urls = fetchMock.mock.calls.map(([url]) => url);
    expect(urls[0]).toBe('https://api.sendblue.example.test/api/send-message');
    expect(urls[1]).toBe('https://api-v2.sendblue.example.test/api/send-group-message');
    expect(urls[2]).toBe('https://api-v2.sendblue.example.test/api/send-reaction');
    expect(urls[3]).toBe('https://api-v2.sendblue.example.test/api/mark-read');
    expect(urls[4]).toBe('https://api-v2.sendblue.example.test/api/send-typing-indicator');
  });

  it('does not coerce empty optional fields into request bodies', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ message_handle: 'm-1' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'OK' }) });
    vi.stubGlobal('fetch', fetchMock);

    const client = new HttpSendblueClient(testConfig());
    await client.sendMessage({
      toNumber: '+15551110001',
      content: 'hi',
      statusCallback: 'https://agent.example.test/webhook/status',
      mediaUrl: undefined,
      sendStyle: undefined
    });
    await client.sendReaction({ messageHandle: 'rx', reaction: 'love', partIndex: undefined });

    const sendBody = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    const reactionBody = JSON.parse(fetchMock.mock.calls[1]![1].body as string);
    expect(sendBody).not.toHaveProperty('media_url');
    expect(sendBody).not.toHaveProperty('send_style');
    expect(reactionBody).not.toHaveProperty('part_index');
  });

  it('passes part_index = 0 through to send-reaction', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'OK', message_handle: 'rx', reaction: 'love' })
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new HttpSendblueClient(testConfig());
    await client.sendReaction({ messageHandle: 'rx', reaction: 'love', partIndex: 0 });

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.part_index).toBe(0);
  });

  it('propagates fetch failures (network/DNS errors) without wrapping', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', fetchMock);

    const client = new HttpSendblueClient(testConfig());
    await expect(
      client.sendTypingIndicator({ toNumber: '+15551110001' })
    ).rejects.toThrow(/fetch failed/);
  });

  it('creates a contact via /api/v2/contacts on the v2 base URL with snake_case body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'CREATED', number: '+15551110001' })
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new HttpSendblueClient(testConfig());
    const result = await client.createContact({
      number: '+15551110001',
      firstName: 'Ada',
      lastName: 'Lovelace',
      sendblueNumber: '+15552220000',
      tags: ['agent', 'beta'],
      customVariables: { plan: 'agent', cohort: 'alpha' },
      updateIfExists: true
    });

    expect(result.number).toBe('+15551110001');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api-v2.sendblue.example.test/api/v2/contacts',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'sb-api-key-id': 'test-key-id',
          'sb-api-secret-key': 'test-secret-key'
        }),
        body: JSON.stringify({
          number: '+15551110001',
          first_name: 'Ada',
          last_name: 'Lovelace',
          sendblue_number: '+15552220000',
          tags: ['agent', 'beta'],
          custom_variables: { plan: 'agent', cohort: 'alpha' },
          update_if_exists: true
        })
      })
    );
  });

  it('omits absent / empty optional contact fields from the body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'CREATED', number: '+15551110001' })
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new HttpSendblueClient(testConfig());
    await client.createContact({
      number: '+15551110001',
      firstName: undefined,
      lastName: '',
      tags: [],
      customVariables: {},
      updateIfExists: true
    });

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string) as Record<string, unknown>;
    expect(body).toEqual({ number: '+15551110001', update_if_exists: true });
    expect(body).not.toHaveProperty('first_name');
    expect(body).not.toHaveProperty('last_name');
    expect(body).not.toHaveProperty('tags');
    expect(body).not.toHaveProperty('custom_variables');
  });

  it('reads contact number from the live wrapped { status, contact: { phone } } response shape', async () => {
    // Real Sendblue response shape verified on 2026-05-09 via
    // `npm run probe:contacts`: the nested contact uses `phone`, not `number`.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'OK',
        contact: {
          phone: '+15551110001',
          first_name: 'Ada',
          last_name: 'Lovelace',
          sendblue_number: '+15552220000',
          tags: ['probe'],
          created_at: '2026-05-09T00:00:00.000Z'
        }
      })
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new HttpSendblueClient(testConfig());
    const result = await client.createContact({ number: '+15551110001', updateIfExists: true });
    expect(result.number).toBe('+15551110001');
  });

  it('falls back to the flat { number } response shape if Sendblue ever returns it', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'OK', number: '+15551110001' })
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new HttpSendblueClient(testConfig());
    const result = await client.createContact({ number: '+15551110001', updateIfExists: true });
    expect(result.number).toBe('+15551110001');
  });

  it('rejects create-contact without a number before issuing a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const client = new HttpSendblueClient(testConfig());
    await expect(client.createContact({ number: '', updateIfExists: true })).rejects.toThrow(/number/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws SendblueApiError on non-2xx for create-contact (e.g. 429 contacts rate-limit)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ status: 'ERROR', error_code: '5509', error_message: 'Rate limit exceeded' })
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new HttpSendblueClient(testConfig());
    let thrown: unknown;
    try {
      await client.createContact({ number: '+15551110001', updateIfExists: true });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SendblueApiError);
    const apiError = thrown as SendblueApiError;
    expect(apiError.operation).toBe('create-contact');
    expect(apiError.httpStatus).toBe(429);
    expect(apiError.errorCode).toBe('5509');
  });
});
