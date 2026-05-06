import type { AgentConfig } from '../config/env.js';
import type { ChatEndpointRequest, ChatEndpointResponse } from './types.js';
import { normalizeChatResponse } from './contract.js';
import { ChatEndpointError } from './errors.js';

export type ChatClient = {
  complete(request: ChatEndpointRequest): Promise<ChatEndpointResponse>;
};

export { normalizeChatResponse, outboundMessagesFromResponse, parseTaggedText } from './contract.js';
export { ChatEndpointError } from './errors.js';

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

      return normalizeChatResponse(await response.json(), {
        tags: this.config.chatResponseTags,
        parseTags: this.config.chatResponseParseTags
      });
    } catch (error) {
      if (error instanceof ChatEndpointError) throw error;
      throw new ChatEndpointError('Chat endpoint request failed', error);
    } finally {
      clearTimeout(timeout);
    }
  }
}
