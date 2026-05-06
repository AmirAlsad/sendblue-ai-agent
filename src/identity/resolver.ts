import type { AgentConfig } from '../config/env.js';
import type { ConversationIdentity } from '../conversation/types.js';

export type IdentityLookupInput = {
  phoneNumber: string;
  lineNumber: string;
  conversationKey: string;
};

export type IdentityResolver = {
  resolveByPhone(input: IdentityLookupInput): Promise<ConversationIdentity | null>;
};

/**
 * Normalize a JSON payload returned from the developer's `USER_LOOKUP_URL`.
 *
 * Accepted shapes:
 * - `null` -> resolves to `null` (no identity for this phone).
 * - `{ userId: string; data?: unknown; authorized?: boolean }` -> resolved identity.
 *
 * Anything else (arrays, primitives, missing/blank `userId`) is treated as a null
 * identity rather than throwing, so a misbehaving resolver upstream cannot block
 * message delivery. The package does not interpret `data`; it is forwarded
 * opaquely to the chat endpoint.
 */
function normalizeIdentity(payload: unknown): ConversationIdentity | null {
  if (payload === null) return null;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;

  const record = payload as Record<string, unknown>;
  if (typeof record.userId !== 'string' || record.userId.trim() === '') return null;

  return {
    userId: record.userId,
    data: record.data,
    authorized: typeof record.authorized === 'boolean' ? record.authorized : undefined
  };
}

/**
 * Default `USER_LOOKUP_URL` request timeout when
 * `IDENTITY_RESOLVER_TIMEOUT_MS` is not set on the config.
 *
 * Identity lookup sits inline before the chat call, so a hung upstream lookup
 * would otherwise stall buffering and outbound delivery. The agent layer
 * already catches errors from this resolver and falls open with
 * `identity: null` (`ConversationAgent.resolveIdentity`).
 */
const DEFAULT_IDENTITY_RESOLVER_TIMEOUT_MS = 5000;

/**
 * Optional HTTP-based identity resolver. Fail-open semantics live in
 * `ConversationAgent.resolveIdentity` — the agent catches any rejection from
 * this resolver, logs a warning with the conversation key, and continues with
 * `identity: null`. This class therefore intentionally throws on transport,
 * timeout, and non-2xx responses so the failure shows up in logs instead of
 * being silently coerced to "no identity".
 *
 * The lookup is a `POST` whose JSON body is documented in
 * `docs/features/identity-resolver.md`. The Sendblue Contacts v2 API
 * (`GET /api/v2/contacts/:phone_number`) is not used as a fallback because
 * Sendblue contacts are operator-managed metadata, not application user
 * identity, and the developer is expected to provide their own auth/CRM
 * lookup.
 */
export class HttpIdentityResolver implements IdentityResolver {
  constructor(
    private readonly config: Pick<AgentConfig, 'userLookupUrl' | 'identityResolverTimeoutMs'>
  ) {}

  async resolveByPhone(input: IdentityLookupInput): Promise<ConversationIdentity | null> {
    if (!this.config.userLookupUrl) return null;

    const timeoutMs = this.config.identityResolverTimeoutMs ?? DEFAULT_IDENTITY_RESOLVER_TIMEOUT_MS;

    const response = await fetch(this.config.userLookupUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        resolveBy: 'phone',
        value: input.phoneNumber,
        phoneNumber: input.phoneNumber,
        lineNumber: input.lineNumber,
        conversationKey: input.conversationKey
      }),
      signal: timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined
    });

    if (!response.ok) {
      throw new Error(`Identity resolver failed with ${response.status}`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new Error(`Identity resolver returned invalid JSON: ${(error as Error).message}`);
    }

    return normalizeIdentity(payload);
  }
}
