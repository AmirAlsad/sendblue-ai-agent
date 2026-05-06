import type { AgentConfig } from '../config/env.js';
import type {
  SendblueOutboundMessage,
  SendblueSendResult,
  SendblueTypingIndicator,
  SendblueTypingIndicatorResult
} from './types.js';

export type SendblueClient = {
  sendMessage(message: SendblueOutboundMessage): Promise<SendblueSendResult>;
  sendTypingIndicator(indicator: SendblueTypingIndicator): Promise<SendblueTypingIndicatorResult>;
};

export class HttpSendblueClient implements SendblueClient {
  constructor(private readonly config: AgentConfig) {}

  async sendMessage(message: SendblueOutboundMessage): Promise<SendblueSendResult> {
    if (!message.statusCallback) {
      throw new Error('Sendblue send-message requires status_callback');
    }

    const response = await fetch(`${this.config.sendblueApiBaseUrl}/api/send-message`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'sb-api-key-id': this.config.sendblueApiKeyId,
        'sb-api-secret-key': this.config.sendblueApiSecretKey
      },
      body: JSON.stringify({
        number: message.toNumber,
        from_number: this.config.sendblueFromNumber,
        content: message.content,
        status_callback: message.statusCallback
      })
    });

    const raw = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(`Sendblue send-message failed with ${response.status}`);
    }

    return {
      messageHandle:
        typeof raw === 'object' &&
        raw !== null &&
        'message_handle' in raw &&
        typeof raw.message_handle === 'string'
          ? raw.message_handle
          : undefined,
      raw
    };
  }

  async sendTypingIndicator(indicator: SendblueTypingIndicator): Promise<SendblueTypingIndicatorResult> {
    const response = await fetch(`${this.config.sendblueApiBaseUrl}/api/send-typing-indicator`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'sb-api-key-id': this.config.sendblueApiKeyId,
        'sb-api-secret-key': this.config.sendblueApiSecretKey
      },
      body: JSON.stringify({
        number: indicator.toNumber,
        from_number: this.config.sendblueFromNumber
      })
    });

    const raw = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(`Sendblue send-typing-indicator failed with ${response.status}`);
    }

    return {
      status:
        typeof raw === 'object' && raw !== null && 'status' in raw && typeof raw.status === 'string'
          ? raw.status
          : undefined,
      errorMessage:
        typeof raw === 'object' &&
        raw !== null &&
        'error_message' in raw &&
        (typeof raw.error_message === 'string' || raw.error_message === null)
          ? raw.error_message
          : undefined,
      raw
    };
  }
}
