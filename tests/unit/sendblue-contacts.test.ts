import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { SendblueApiError } from '../../src/sendblue/client.js';
import { buildContactBody, upsertContactFromIdentity } from '../../src/sendblue/contacts.js';
import type { ConversationIdentity } from '../../src/conversation/types.js';

const silentLogger = pino({ level: 'silent' });

describe('buildContactBody', () => {
  it('always sets update_if_exists to true by default', () => {
    const body = buildContactBody({ number: '+15551110001' });
    expect(body.updateIfExists).toBe(true);
  });

  it('respects an explicit updateIfExists override', () => {
    const body = buildContactBody({ number: '+15551110001', updateIfExists: false });
    expect(body.updateIfExists).toBe(false);
  });

  it('dedupes and trims tags, drops empty entries', () => {
    const body = buildContactBody({
      number: '+15551110001',
      tags: [' agent ', 'agent', '', 'beta', 'beta', ' ']
    });
    expect(body.tags).toEqual(['agent', 'beta']);
  });

  it('dedupes tags case-insensitively, preserving first-occurrence casing', () => {
    const body = buildContactBody({
      number: '+15551110001',
      tags: ['Agent', 'agent', 'AGENT', 'Beta', 'beta', 'tier:gold', 'TIER:GOLD']
    });
    expect(body.tags).toEqual(['Agent', 'Beta', 'tier:gold']);
  });

  it('returns undefined for empty tag arrays', () => {
    const body = buildContactBody({ number: '+15551110001', tags: [] });
    expect(body.tags).toBeUndefined();
  });
});

describe('upsertContactFromIdentity', () => {
  function makeClient(stub: typeof vi.fn = vi.fn) {
    const createContact = stub();
    return {
      createContact,
      asClient: { createContact: createContact as unknown as Parameters<typeof upsertContactFromIdentity>[0]['client']['createContact'] }
    };
  }

  it('returns no-identity when identity is null', async () => {
    const client = { createContact: vi.fn() };
    const outcome = await upsertContactFromIdentity({
      client,
      phoneNumber: '+15551110001',
      identity: null,
      logger: silentLogger
    });
    expect(outcome).toEqual({ upserted: false, reason: 'no-identity' });
    expect(client.createContact).not.toHaveBeenCalled();
  });

  it('returns no-name when identity has neither firstName nor lastName', async () => {
    const client = { createContact: vi.fn() };
    const outcome = await upsertContactFromIdentity({
      client,
      phoneNumber: '+15551110001',
      identity: { userId: 'u-1' } satisfies ConversationIdentity,
      logger: silentLogger
    });
    expect(outcome).toEqual({ upserted: false, reason: 'no-name' });
    expect(client.createContact).not.toHaveBeenCalled();
  });

  it('treats whitespace-only names as no-name', async () => {
    const client = { createContact: vi.fn() };
    const outcome = await upsertContactFromIdentity({
      client,
      phoneNumber: '+15551110001',
      identity: { userId: 'u-1', firstName: '   ', lastName: '\t' },
      logger: silentLogger
    });
    expect(outcome).toEqual({ upserted: false, reason: 'no-name' });
    expect(client.createContact).not.toHaveBeenCalled();
  });

  it('upserts with firstName only and forwards default tags + sendblueNumber', async () => {
    const createContact = vi.fn().mockResolvedValue({ number: '+15551110001', raw: { ok: true } });
    const outcome = await upsertContactFromIdentity({
      client: { createContact },
      phoneNumber: '+15551110001',
      sendblueNumber: '+15552220000',
      identity: { userId: 'u-1', firstName: 'Ada' },
      defaultTags: ['agent'],
      logger: silentLogger
    });
    expect(outcome).toMatchObject({ upserted: true });
    expect(createContact).toHaveBeenCalledWith({
      number: '+15551110001',
      firstName: 'Ada',
      lastName: undefined,
      sendblueNumber: '+15552220000',
      tags: ['agent'],
      customVariables: undefined,
      updateIfExists: true
    });
  });

  it('combines default tags with identity tags and forwards custom variables', async () => {
    const createContact = vi.fn().mockResolvedValue({ number: '+15551110001', raw: { ok: true } });
    await upsertContactFromIdentity({
      client: { createContact },
      phoneNumber: '+15551110001',
      sendblueNumber: '+15552220000',
      identity: {
        userId: 'u-2',
        firstName: 'Ada',
        lastName: 'Lovelace',
        tags: ['tier:gold'],
        customVariables: { plan: 'agent' }
      },
      defaultTags: ['agent', 'beta'],
      logger: silentLogger
    });
    expect(createContact).toHaveBeenCalledWith(
      expect.objectContaining({
        tags: ['agent', 'beta', 'tier:gold'],
        customVariables: { plan: 'agent' }
      })
    );
  });

  it('catches SendblueApiError and returns reason=error without throwing', async () => {
    const apiError = new SendblueApiError({
      operation: 'create-contact',
      httpStatus: 429,
      errorCode: '5509',
      serverMessage: 'Rate limit exceeded',
      responseBody: null,
      message: 'Sendblue create-contact failed with 429'
    });
    const createContact = vi.fn().mockRejectedValue(apiError);

    const outcome = await upsertContactFromIdentity({
      client: { createContact },
      phoneNumber: '+15551110001',
      identity: { userId: 'u-1', firstName: 'Ada' },
      logger: silentLogger
    });

    expect(outcome.upserted).toBe(false);
    if (!outcome.upserted) {
      expect(outcome.reason).toBe('error');
      expect(outcome.error).toBe(apiError);
    }
  });

  it('catches generic errors as well', async () => {
    const createContact = vi.fn().mockRejectedValue(new Error('boom'));
    const outcome = await upsertContactFromIdentity({
      client: { createContact },
      phoneNumber: '+15551110001',
      identity: { userId: 'u-1', firstName: 'Ada' },
      logger: silentLogger
    });
    expect(outcome).toMatchObject({ upserted: false, reason: 'error' });
  });
});
