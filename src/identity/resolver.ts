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

export class HttpIdentityResolver implements IdentityResolver {
  constructor(private readonly config: AgentConfig) {}

  async resolveByPhone(input: IdentityLookupInput): Promise<ConversationIdentity | null> {
    if (!this.config.userLookupUrl) return null;

    const response = await fetch(this.config.userLookupUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        resolveBy: 'phone',
        value: input.phoneNumber,
        phoneNumber: input.phoneNumber,
        lineNumber: input.lineNumber,
        conversationKey: input.conversationKey
      })
    });

    if (!response.ok) {
      throw new Error(`Identity resolver failed with ${response.status}`);
    }

    return normalizeIdentity(await response.json());
  }
}
