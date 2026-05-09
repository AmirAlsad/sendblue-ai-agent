import type pino from 'pino';
import type { ConversationIdentity } from '../conversation/types.js';
import type { SendblueClient } from './client.js';
import { SendblueApiError } from './client.js';
import type { SendblueContactRequest, SendblueContactResult } from './types.js';

/**
 * Outcome of an `upsertContactFromIdentity` attempt. Distinct reasons let
 * callers branch on whether the helper made an API call (`upserted: true`)
 * or skipped because the identity didn't carry a name (`reason: 'no-name'`),
 * or whether the upstream API errored (`reason: 'error'`).
 */
export type UpsertContactOutcome =
  | { upserted: true; result: SendblueContactResult }
  | { upserted: false; reason: 'no-identity' | 'no-name' | 'error'; error?: unknown };

/**
 * Build the snake_case body shape Sendblue's create-contact endpoint expects.
 * `update_if_exists` defaults to `true` because Sendblue's docs do not
 * document the duplicate-POST behavior without it; callers always want
 * upsert semantics.
 */
export function buildContactBody(req: SendblueContactRequest): SendblueContactRequest {
  return {
    number: req.number,
    firstName: req.firstName,
    lastName: req.lastName,
    sendblueNumber: req.sendblueNumber,
    tags: mergeTags(req.tags),
    customVariables: req.customVariables,
    updateIfExists: req.updateIfExists ?? true
  };
}

function mergeTags(tags: string[] | undefined): string[] | undefined {
  if (!tags || tags.length === 0) return undefined;
  // Dedupe case-insensitively (e.g. ['Agent', 'agent'] → ['Agent']) so a mix
  // of `SENDBLUE_CONTACTS_DEFAULT_TAGS` casings and resolver-supplied tags
  // does not produce visible duplicates in the Sendblue dashboard. Preserve
  // the casing of the first occurrence.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of tags) {
    const trimmed = typeof tag === 'string' ? tag.trim() : '';
    if (!trimmed) continue;
    const fold = trimmed.toLowerCase();
    if (seen.has(fold)) continue;
    seen.add(fold);
    out.push(trimmed);
  }
  return out.length > 0 ? out : undefined;
}

export type UpsertContactInput = {
  /**
   * Sendblue client to call. Marked `Pick<>` so callers can pass narrow
   * fakes without implementing the full surface.
   */
  client: Pick<SendblueClient, 'createContact'>;
  /** E.164 phone number for the contact being upserted. */
  phoneNumber: string;
  /** E.164 of the Sendblue line owning the conversation, used as `sendblue_number`. */
  sendblueNumber?: string;
  /** Identity returned by the developer's identity resolver. */
  identity: ConversationIdentity | null | undefined;
  /** Tags applied to every upsert from this deployment (e.g. `["agent"]`). */
  defaultTags?: string[];
  /** Pino logger; the helper logs at debug/info on outcome. */
  logger: pino.Logger;
};

/**
 * Upsert a Sendblue contact from a resolved identity.
 *
 * Behavior:
 * - Returns `{upserted:false, reason:'no-identity'}` when identity is null.
 * - Returns `{upserted:false, reason:'no-name'}` when neither `firstName`
 *   nor `lastName` is set on the identity. (Per locked design: only contacts
 *   with a known name are auto-created. The Sendblue dashboard would
 *   otherwise fill up with unnamed E.164 entries.)
 * - Otherwise calls `client.createContact` with `update_if_exists: true` and
 *   merged tags/custom variables.
 *
 * Never throws. Errors from the Sendblue API are caught and surfaced as
 * `{upserted:false, reason:'error', error}` so the caller (the conversation
 * agent) can treat contact creation as fire-and-forget without wrapping
 * every site in try/catch.
 */
export async function upsertContactFromIdentity(
  input: UpsertContactInput
): Promise<UpsertContactOutcome> {
  const { client, phoneNumber, sendblueNumber, identity, defaultTags, logger } = input;

  if (!identity) {
    return { upserted: false, reason: 'no-identity' };
  }

  const firstName = identity.firstName?.trim() || undefined;
  const lastName = identity.lastName?.trim() || undefined;
  if (!firstName && !lastName) {
    return { upserted: false, reason: 'no-name' };
  }

  const body = buildContactBody({
    number: phoneNumber,
    firstName,
    lastName,
    sendblueNumber,
    tags: combineTags(defaultTags, identity.tags),
    customVariables: identity.customVariables,
    updateIfExists: true
  });

  try {
    const result = await client.createContact(body);
    logger.info(
      {
        phoneNumber,
        sendblueNumber,
        userId: identity.userId,
        firstName,
        lastName,
        tags: body.tags
      },
      'Sendblue contact upserted'
    );
    return { upserted: true, result };
  } catch (error) {
    const errorCode = error instanceof SendblueApiError ? error.errorCode : undefined;
    const httpStatus = error instanceof SendblueApiError ? error.httpStatus : undefined;
    logger.warn(
      { err: error, phoneNumber, sendblueNumber, userId: identity.userId, errorCode, httpStatus },
      'Sendblue contact upsert failed'
    );
    return { upserted: false, reason: 'error', error };
  }
}

function combineTags(defaultTags: string[] | undefined, identityTags: string[] | undefined): string[] | undefined {
  const all: string[] = [];
  if (defaultTags) all.push(...defaultTags);
  if (identityTags) all.push(...identityTags);
  return all.length > 0 ? all : undefined;
}
