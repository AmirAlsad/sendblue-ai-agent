import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpIdentityResolver } from '../../src/identity/resolver.js';
import { testConfig } from '../helpers/config.js';

const sampleInput = {
  phoneNumber: '+15551110001',
  lineNumber: '+15552220000',
  conversationKey: 'direct:+15552220000:+15551110001'
};

function makeResolver(overrides = {}) {
  return new HttpIdentityResolver(
    testConfig({ userLookupUrl: 'https://users.example.test/lookup', ...overrides })
  );
}

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
    const resolver = makeResolver();

    await expect(resolver.resolveByPhone(sampleInput)).resolves.toEqual({
      userId: 'user-123',
      data: { tier: 'gold' }
    });

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

  it('forwards the optional authorized boolean when present', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ userId: 'user-1', authorized: false }), { status: 200 })
    );
    const resolver = makeResolver();

    await expect(resolver.resolveByPhone(sampleInput)).resolves.toEqual({
      userId: 'user-1',
      data: undefined,
      authorized: false
    });
  });

  it('returns null without calling fetch when USER_LOOKUP_URL is unset', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const resolver = new HttpIdentityResolver(testConfig({ userLookupUrl: undefined }));

    await expect(resolver.resolveByPhone(sampleInput)).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns null for null or unrecognized resolver payloads', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('null', { status: 200 }));
    const resolver = makeResolver();

    await expect(resolver.resolveByPhone(sampleInput)).resolves.toBeNull();
  });

  it('treats arrays and primitives as null identity', async () => {
    const resolver = makeResolver();

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('[]', { status: 200 }));
    await expect(resolver.resolveByPhone(sampleInput)).resolves.toBeNull();

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('"user-1"', { status: 200 }));
    await expect(resolver.resolveByPhone(sampleInput)).resolves.toBeNull();
  });

  it('treats missing or blank userId as null identity', async () => {
    const resolver = makeResolver();

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { tier: 'gold' } }), { status: 200 })
    );
    await expect(resolver.resolveByPhone(sampleInput)).resolves.toBeNull();

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ userId: '   ' }), { status: 200 })
    );
    await expect(resolver.resolveByPhone(sampleInput)).resolves.toBeNull();
  });

  it('throws on non-2xx so the agent layer can log and fail open', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('boom', { status: 500 }));
    const resolver = makeResolver();

    await expect(resolver.resolveByPhone(sampleInput)).rejects.toThrow(/500/);
  });

  it('throws on transport errors so the agent layer can log and fail open', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('network down'));
    const resolver = makeResolver();

    await expect(resolver.resolveByPhone(sampleInput)).rejects.toThrow(/network down/);
  });

  it('throws when the lookup body is invalid JSON', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('not-json', { status: 200, headers: { 'content-type': 'application/json' } })
    );
    const resolver = makeResolver();

    await expect(resolver.resolveByPhone(sampleInput)).rejects.toThrow(/invalid JSON/i);
  });

  it('aborts the request when identityResolverTimeoutMs elapses', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      return new Promise((_resolve, reject) => {
        const signal = (init as RequestInit | undefined)?.signal as AbortSignal | undefined;
        signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')));
      });
    });
    const resolver = makeResolver({ identityResolverTimeoutMs: 5 });

    await expect(resolver.resolveByPhone(sampleInput)).rejects.toBeDefined();
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('omits the abort signal when identityResolverTimeoutMs is 0', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ userId: 'u' }), { status: 200 })
    );
    const resolver = makeResolver({ identityResolverTimeoutMs: 0 });

    await resolver.resolveByPhone(sampleInput);
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.signal).toBeUndefined();
  });
});
