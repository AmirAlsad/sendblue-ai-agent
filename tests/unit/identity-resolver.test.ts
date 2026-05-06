import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpIdentityResolver } from '../../src/identity/resolver.js';
import { testConfig } from '../helpers/config.js';

describe('HttpIdentityResolver', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves a user identity over HTTP', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ userId: 'user-123', data: { tier: 'gold' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
    const resolver = new HttpIdentityResolver(testConfig({ userLookupUrl: 'https://users.example.test/lookup' }));

    await expect(
      resolver.resolveByPhone({
        phoneNumber: '+15551110001',
        lineNumber: '+15552220000',
        conversationKey: 'direct:+15552220000:+15551110001'
      })
    ).resolves.toEqual({ userId: 'user-123', data: { tier: 'gold' } });

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://users.example.test/lookup',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          resolveBy: 'phone',
          value: '+15551110001',
          phoneNumber: '+15551110001',
          lineNumber: '+15552220000',
          conversationKey: 'direct:+15552220000:+15551110001'
        })
      })
    );
  });

  it('returns null for null or unrecognized resolver payloads', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('null', { status: 200 }));
    const resolver = new HttpIdentityResolver(testConfig({ userLookupUrl: 'https://users.example.test/lookup' }));

    await expect(
      resolver.resolveByPhone({
        phoneNumber: '+15551110001',
        lineNumber: '+15552220000',
        conversationKey: 'direct:+15552220000:+15551110001'
      })
    ).resolves.toBeNull();
  });
});
