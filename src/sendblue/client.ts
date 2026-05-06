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

/**
 * Outbound surface for the Sendblue HTTP API.
 *
 * Implementations cover only the endpoints the conversation agent
 * orchestrates today (send, group send, reactions, mark-read, typing).
 * Endpoints documented by Sendblue but not used by this package
 * (`/api/evaluate-service`, `/api/modify-group`, `/api/send-carousel`,
 * `/api/v2/messages`, `/api/account/webhooks`, contacts) are intentionally
 * out of scope — see {@link HttpSendblueClient} for rationale.
 */
export type SendblueClient = {
  sendMessage(message: SendblueOutboundMessage): Promise<SendblueSendResult>;
  sendGroupMessage(message: SendblueOutboundGroupMessage): Promise<SendblueSendResult>;
  sendReaction(reaction: SendblueReactionRequest): Promise<SendblueActionResult>;
  markRead(receipt: SendblueMarkReadRequest): Promise<SendblueActionResult>;
  sendTypingIndicator(indicator: SendblueTypingIndicator): Promise<SendblueTypingIndicatorResult>;
};

/**
 * Structured error thrown for any non-2xx Sendblue API response.
 *
 * Subclasses {@link Error} so existing `instanceof Error` and message-matching
 * code continues to work, but additionally exposes the HTTP status, the
 * documented `error_code` (when present), and the decoded raw body so
 * callers can branch on conditions like rate limiting (`5509`/`5003`),
 * SMS limits (`SMS_LIMIT_REACHED`), or validation (`4000`).
 *
 * Mirrors the field naming used by status callback handling in
 * {@link "../status/tracker.ts"} so the same `errorCode` value can be
 * piped through {@link "../status/tracker.ts".classifyErrorCode}.
 */
export class SendblueApiError extends Error {
  /** Logical operation name (e.g. `"send-message"`, `"send-reaction"`). */
  readonly operation: string;
  /** HTTP status returned by Sendblue. `0` when the request failed before a response. */
  readonly httpStatus: number;
  /** Sendblue `error_code` value if present in the response body. */
  readonly errorCode?: string;
  /** Server-supplied human message — `message` or `error_message` from the body. */
  readonly serverMessage?: string;
  /** Decoded JSON body, or `null` when the body could not be parsed. */
  readonly responseBody: unknown;

  constructor(args: {
    operation: string;
    httpStatus: number;
    errorCode?: string;
    serverMessage?: string;
    responseBody: unknown;
    message: string;
  }) {
    super(args.message);
    this.name = 'SendblueApiError';
    this.operation = args.operation;
    this.httpStatus = args.httpStatus;
    this.errorCode = args.errorCode;
    this.serverMessage = args.serverMessage;
    this.responseBody = args.responseBody;
  }
}

/**
 * HTTP client for the documented subset of Sendblue endpoints used by the
 * conversation agent.
 *
 * Why a custom client (and not `@sendblue/api`):
 * The conversation agent's ordered-delivery and status-tracking contract
 * relies on attaching a *per-message* `status_callback` to every
 * `/api/send-message` call. Owning the request shape avoids surprising
 * SDK upgrades that could change the field, and lets us preserve other
 * load-bearing rules (forced `from_number`, optional fields only when
 * non-empty, structured error reporting via {@link SendblueApiError}).
 *
 * All requests use the documented header pair `sb-api-key-id` /
 * `sb-api-secret-key`. The host split is configurable:
 *
 * - `sendblueApiBaseUrl` (default `https://api.sendblue.co`) for
 *   `/api/send-message`. Sendblue's send-message reference page documents
 *   this host explicitly.
 * - `sendblueApiV2BaseUrl` (default `https://api.sendblue.com`) for the
 *   v2-documented endpoints (`send-group-message`, `send-reaction`,
 *   `mark-read`, `send-typing-indicator`).
 *
 * iMessage-only suppression (effects, reactions, replies, mark-read,
 * typing) is intentionally **not** enforced here. The conversation agent
 * owns that gating because it has access to per-conversation channel and
 * downgrade state. The client makes the requested call as documented.
 */
export class HttpSendblueClient implements SendblueClient {
  constructor(private readonly config: AgentConfig) {}

  /**
   * Send a direct iMessage / SMS / RCS message via `POST /api/send-message`.
   *
   * Endpoint: `POST {sendblueApiBaseUrl}/api/send-message`
   * Docs: https://docs.sendblue.com/api/resources/messages/methods/send/
   *
   * Required Sendblue body fields are populated from `message`/config:
   * `number`, `from_number`, `content`, `status_callback`. Optional
   * fields are forwarded only when set: `media_url`, `send_style`.
   *
   * @throws Error when `statusCallback` is empty — load-bearing per
   *   AGENTS.md: every send-message must pass its own callback URL.
   * @throws {SendblueApiError} on any non-2xx response, with `errorCode`
   *   set from the response body when the documented `error_code` is
   *   present (`4000`, `4001`, `4002`, `5000`, `5003`, `5509`, `10001`,
   *   `10002`, `SMS_LIMIT_REACHED`).
   */
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
      ...optionalField('send_style', message.sendStyle),
      ...optionalField('seat_id', message.seatId)
    });

    return {
      messageHandle: readString(raw, 'message_handle'),
      raw
    };
  }

  /**
   * Send a group message via `POST /api/send-group-message`.
   *
   * Endpoint: `POST {sendblueApiV2BaseUrl}/api/send-group-message`
   * Docs: https://docs.sendblue.com/getting-started/groups/
   *
   * `status_callback` is optional here (Sendblue's docs do not require it
   * on group sends), but the conversation agent should still pass one
   * when it expects ordered-delivery advancement on the group queue.
   *
   * @throws {SendblueApiError} on any non-2xx response.
   */
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

  /**
   * Send a Tapback reaction via `POST /api/send-reaction`.
   *
   * Endpoint: `POST {sendblueApiV2BaseUrl}/api/send-reaction`
   * Docs: https://docs.sendblue.com/api-v2/reactions/
   *
   * iMessage-only — Sendblue rejects reactions on SMS conversations.
   * The conversation agent suppresses reactions for downgraded/SMS
   * channels before reaching this method.
   *
   * @throws {SendblueApiError} on any non-2xx response (e.g. `400`
   *   `INVALID_REACTION`, missing `from_number`/`message_handle`,
   *   `404` line-not-registered).
   */
  async sendReaction(reaction: SendblueReactionRequest): Promise<SendblueActionResult> {
    const raw = await this.postJson(this.config.sendblueApiV2BaseUrl, '/api/send-reaction', 'send-reaction', {
      from_number: this.config.sendblueFromNumber,
      message_handle: reaction.messageHandle,
      reaction: reaction.reaction,
      ...optionalField('part_index', reaction.partIndex)
    });

    return actionResult(raw);
  }

  /**
   * Send a read receipt via `POST /api/mark-read`.
   *
   * Endpoint: `POST {sendblueApiV2BaseUrl}/api/mark-read`
   * Docs: https://docs.sendblue.com/api-v2/read-receipts/
   *
   * Best-effort and iMessage/RCS-only. There is **no** corresponding
   * `READ` status callback — do not assume one. Gated by
   * `READ_RECEIPTS_ENABLED` at the agent layer.
   *
   * @throws {SendblueApiError} on any non-2xx response.
   */
  async markRead(receipt: SendblueMarkReadRequest): Promise<SendblueActionResult> {
    const raw = await this.postJson(this.config.sendblueApiV2BaseUrl, '/api/mark-read', 'mark-read', {
      number: receipt.toNumber,
      from_number: this.config.sendblueFromNumber
    });

    return actionResult(raw);
  }

  /**
   * Send a typing indicator via `POST /api/send-typing-indicator`.
   *
   * Endpoint: `POST {sendblueApiV2BaseUrl}/api/send-typing-indicator`
   * Docs: https://docs.sendblue.com/api-v2/typing-indicators/
   *
   * iMessage-only and requires a prior conversation with the recipient
   * (Sendblue returns a 400 `No route mapping found` error otherwise).
   * Sendblue does not document a "stop typing" call — Messages.app
   * times out the indicator on its own.
   *
   * @throws {SendblueApiError} on any non-2xx response.
   */
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

function sendblueError(operation: string, status: number, raw: unknown): SendblueApiError {
  const errorCode = readString(raw, 'error_code');
  const serverMessage = readString(raw, 'message') ?? readString(raw, 'error_message') ?? undefined;
  const detail = [errorCode, serverMessage].filter(Boolean).join(': ');
  return new SendblueApiError({
    operation,
    httpStatus: status,
    errorCode,
    serverMessage,
    responseBody: raw,
    message: `Sendblue ${operation} failed with ${status}${detail ? ` (${detail})` : ''}`
  });
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
