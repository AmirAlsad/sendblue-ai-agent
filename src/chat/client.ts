import type { AgentConfig } from '../config/env.js';
import type { ChatEndpointRequest, ChatEndpointResponse } from './types.js';

export type ChatClient = {
  complete(request: ChatEndpointRequest): Promise<ChatEndpointResponse>;
};

export class ChatEndpointError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'ChatEndpointError';
  }
}

export function normalizeChatResponse(payload: unknown): ChatEndpointResponse {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new ChatEndpointError('Chat endpoint response must be an object');
  }

  const record = payload as Record<string, unknown>;
  if (record.silence === true) return { silence: true };

  if (typeof record.message === 'string' && record.message.trim() !== '') {
    return { messages: [record.message] };
  }

  if (Array.isArray(record.messages)) {
    const messages = record.messages.filter(
      (message): message is string => typeof message === 'string' && message.trim() !== ''
    );
    if (messages.length > 0) return { messages };
  }

  throw new ChatEndpointError('Chat endpoint response did not include message, messages, or silence');
}

export class HttpChatClient implements ChatClient {
  constructor(private readonly config: AgentConfig) {}

  async complete(request: ChatEndpointRequest): Promise<ChatEndpointResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.chatEndpointTimeoutMs);

    try {
      const response = await fetch(this.config.chatEndpointUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
        signal: controller.signal
      });

      if (!response.ok) {
        throw new ChatEndpointError(`Chat endpoint failed with ${response.status}`);
      }

      return normalizeChatResponse(await response.json());
    } catch (error) {
      if (error instanceof ChatEndpointError) throw error;
      throw new ChatEndpointError('Chat endpoint request failed', error);
    } finally {
      clearTimeout(timeout);
    }
  }
}
