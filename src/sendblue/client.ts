import type { AgentConfig } from '../config/env.js';
import type {
  SendblueActionResult,
  SendblueMarkReadRequest,
  SendblueOutboundGroupMessage,
  SendblueOutboundMessage,
  SendblueReactionRequest,
  SendblueSendResult,
  SendblueTypingIndicator,
  SendblueTypingIndicatorResult
} from './types.js';

export type SendblueClient = {
  sendMessage(message: SendblueOutboundMessage): Promise<SendblueSendResult>;
  sendGroupMessage(message: SendblueOutboundGroupMessage): Promise<SendblueSendResult>;
  sendReaction(reaction: SendblueReactionRequest): Promise<SendblueActionResult>;
  markRead(receipt: SendblueMarkReadRequest): Promise<SendblueActionResult>;
  sendTypingIndicator(indicator: SendblueTypingIndicator): Promise<SendblueTypingIndicatorResult>;
};

export class HttpSendblueClient implements SendblueClient {
  constructor(private readonly config: AgentConfig) {}

  async sendMessage(message: SendblueOutboundMessage): Promise<SendblueSendResult> {
    if (!message.statusCallback) {
      throw new Error('Sendblue send-message requires status_callback');
    }

    const raw = await this.postJson(this.config.sendblueApiBaseUrl, '/api/send-message', 'send-message', {
      number: message.toNumber,
      from_number: this.config.sendblueFromNumber,
      content: message.content,
      status_callback: message.statusCallback,
      ...optionalField('media_url', message.mediaUrl),
      ...optionalField('send_style', message.sendStyle)
    });

    return {
      messageHandle: readString(raw, 'message_handle'),
      raw
    };
  }

  async sendGroupMessage(message: SendblueOutboundGroupMessage): Promise<SendblueSendResult> {
    const raw = await this.postJson(this.config.sendblueApiV2BaseUrl, '/api/send-group-message', 'send-group-message', {
      group_id: message.groupId,
      from_number: this.config.sendblueFromNumber,
      content: message.content,
      ...optionalField('status_callback', message.statusCallback),
      ...optionalField('media_url', message.mediaUrl),
      ...optionalField('send_style', message.sendStyle)
    });

    return {
      messageHandle: readString(raw, 'message_handle'),
      raw
    };
  }

  async sendReaction(reaction: SendblueReactionRequest): Promise<SendblueActionResult> {
    const raw = await this.postJson(this.config.sendblueApiV2BaseUrl, '/api/send-reaction', 'send-reaction', {
      from_number: this.config.sendblueFromNumber,
      message_handle: reaction.messageHandle,
      reaction: reaction.reaction,
      ...optionalField('part_index', reaction.partIndex)
    });

    return actionResult(raw);
  }

  async markRead(receipt: SendblueMarkReadRequest): Promise<SendblueActionResult> {
    const raw = await this.postJson(this.config.sendblueApiV2BaseUrl, '/api/mark-read', 'mark-read', {
      number: receipt.toNumber,
      from_number: this.config.sendblueFromNumber
    });

    return actionResult(raw);
  }

  async sendTypingIndicator(indicator: SendblueTypingIndicator): Promise<SendblueTypingIndicatorResult> {
    const raw = await this.postJson(
      this.config.sendblueApiV2BaseUrl,
      '/api/send-typing-indicator',
      'send-typing-indicator',
      {
        number: indicator.toNumber,
        from_number: this.config.sendblueFromNumber
      }
    );

    return {
      status: readString(raw, 'status'),
      errorMessage: readNullableString(raw, 'error_message'),
      raw
    };
  }

  private async postJson(
    baseUrl: string,
    path: string,
    operation: string,
    body: Record<string, unknown>
  ): Promise<unknown> {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'sb-api-key-id': this.config.sendblueApiKeyId,
        'sb-api-secret-key': this.config.sendblueApiSecretKey
      },
      body: JSON.stringify(body)
    });

    const raw = await response.json().catch(() => null);
    if (!response.ok) {
      throw sendblueError(operation, response.status, raw);
    }

    return raw;
  }
}

function actionResult(raw: unknown): SendblueActionResult {
  return {
    status: readString(raw, 'status'),
    message: readString(raw, 'message'),
    errorCode: readString(raw, 'error_code'),
    errorMessage: readNullableString(raw, 'error_message'),
    messageHandle: readString(raw, 'message_handle'),
    reaction: readString(raw, 'reaction'),
    number: readString(raw, 'number'),
    raw
  };
}

function sendblueError(operation: string, status: number, raw: unknown): Error {
  const errorCode = readString(raw, 'error_code');
  const message = readString(raw, 'message') ?? readString(raw, 'error_message');
  const detail = [errorCode, message].filter(Boolean).join(': ');
  return new Error(`Sendblue ${operation} failed with ${status}${detail ? ` (${detail})` : ''}`);
}

function readString(raw: unknown, key: string): string | undefined {
  if (!isRecord(raw)) return undefined;
  const value = raw[key];
  return typeof value === 'string' ? value : undefined;
}

function readNullableString(raw: unknown, key: string): string | null | undefined {
  if (!isRecord(raw)) return undefined;
  const value = raw[key];
  return typeof value === 'string' || value === null ? value : undefined;
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null;
}

function optionalField(key: string, value: unknown): Record<string, unknown> {
  return value === undefined || value === null || value === '' ? {} : { [key]: value };
}
