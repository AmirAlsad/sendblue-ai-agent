import {
  SENDBLUE_STATUSES,
  type SendblueReceiveWebhook,
  type SendblueReceiveStatus,
  type SendblueOperationalWebhook,
  type SendblueStatus,
  type SendblueStatusWebhook
} from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads a string field from a Sendblue webhook payload.
 *
 * - When `required` is true the field must be present and a string. An empty
 *   string is accepted because Sendblue legitimately sends empty values for
 *   fields like `content` (media-only inbounds), `media_url`, `group_id`,
 *   `send_style`, and `group_display_name` without omitting them.
 * - When `requireNonEmpty` is true the field must be present, a string, and
 *   non-empty after trimming. Use this for fields the conversation routing
 *   layer cannot operate without (`from_number`, `to_number`, `message_handle`).
 * - When neither flag is set, returns `undefined` if the field is missing or
 *   not a string. Empty strings pass through.
 */
function readString(
  payload: Record<string, unknown>,
  key: string,
  options: { required?: boolean; requireNonEmpty?: boolean } = {}
): string | undefined {
  const { required = false, requireNonEmpty = false } = options;
  const value = payload[key];
  if (typeof value === 'string') {
    if (requireNonEmpty && value.trim() === '') {
      throw new Error(`Empty required Sendblue field: ${key}`);
    }
    return value;
  }
  if (required || requireNonEmpty) {
    throw new Error(`Missing required Sendblue field: ${key}`);
  }
  return undefined;
}

function readNullableString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  if (typeof value === 'string') return value;
  return null;
}

function readBoolean(payload: Record<string, unknown>, key: string): boolean {
  const value = payload[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return false;
}

function readNullableBoolean(payload: Record<string, unknown>, key: string): boolean | null {
  const value = payload[key];
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return null;
}

export function parseSendblueStatus(value: unknown): SendblueStatus | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.toUpperCase();
  return SENDBLUE_STATUSES.includes(normalized as SendblueStatus)
    ? (normalized as SendblueStatus)
    : undefined;
}

function parseReceiveStatus(value: unknown): SendblueReceiveStatus | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.toUpperCase();
  if (normalized === 'RECEIVED') return 'RECEIVED';
  return parseSendblueStatus(normalized);
}

/**
 * Parses a Sendblue inbound `receive` webhook payload into a normalized
 * {@link SendblueReceiveWebhook}.
 *
 * Required fields per Sendblue docs and observed payloads:
 * `from_number`, `to_number`, `message_handle`. `content` is required to be
 * a string but may be empty (media-only inbounds and tapback echoes from some
 * accounts can ship an empty `content`).
 *
 * The full unparsed payload is preserved on `raw` so unmodeled or
 * future-facing fields (e.g. reply/reaction metadata if Sendblue ships it)
 * can be inspected by downstream consumers without a parser change.
 *
 * Throws an `Error` with a useful message on missing required fields or a
 * non-object payload. Caller should translate to HTTP 400.
 *
 * Reference:
 *  - https://docs.sendblue.com/getting-started/webhooks
 *  - https://docs.sendblue.com/getting-started/receiving-messages
 */
export function parseReceiveWebhook(payload: unknown): SendblueReceiveWebhook {
  if (!isRecord(payload)) {
    throw new Error('Sendblue webhook payload must be an object');
  }

  return {
    content: readString(payload, 'content', { required: true }) ?? '',
    fromNumber: readString(payload, 'from_number', { requireNonEmpty: true })!,
    toNumber: readString(payload, 'to_number', { requireNonEmpty: true })!,
    messageHandle: readString(payload, 'message_handle', { requireNonEmpty: true })!,
    isOutbound: readBoolean(payload, 'is_outbound'),
    status: parseReceiveStatus(payload.status),
    wasDowngraded: readNullableBoolean(payload, 'was_downgraded'),
    service: readString(payload, 'service'),
    mediaUrl: readString(payload, 'media_url') ?? null,
    groupId: readString(payload, 'group_id') ?? null,
    groupDisplayName: readNullableString(payload, 'group_display_name'),
    sendblueNumber: readString(payload, 'sendblue_number') ?? null,
    participants: payload.participants,
    sendStyle: readString(payload, 'send_style') ?? null,
    messageType: readString(payload, 'message_type') ?? null,
    number: readString(payload, 'number') ?? null,
    accountEmail: readString(payload, 'accountEmail') ?? null,
    plan: readString(payload, 'plan') ?? null,
    optedOut: readNullableBoolean(payload, 'opted_out'),
    dateSent: readString(payload, 'date_sent') ?? null,
    dateUpdated: readString(payload, 'date_updated') ?? null,
    senderEmail: readString(payload, 'sender_email') ?? null,
    seatId: readString(payload, 'seat_id') ?? null,
    errorCode: readString(payload, 'error_code'),
    errorMessage: readString(payload, 'error_message'),
    errorDetail: readString(payload, 'error_detail'),
    errorReason: readString(payload, 'error_reason'),
    raw: payload
  };
}

/**
 * Parses a Sendblue outbound message status callback into a normalized
 * {@link SendblueStatusWebhook}.
 *
 * Sendblue documents 8 statuses for outbound delivery:
 * `REGISTERED`, `PENDING`, `DECLINED`, `QUEUED`, `ACCEPTED`, `SENT`,
 * `DELIVERED`, `ERROR`. There is no documented `READ` callback; `RECEIVED`
 * is reserved for inbound payloads. This parser rejects both with an
 * "invalid Sendblue status" error so callers can surface 400s for malformed
 * status callbacks rather than silently coercing.
 *
 * Reference:
 *  - https://docs.sendblue.com/getting-started/webhooks
 *  - https://docs.sendblue.com/getting-started/sending-messages
 */
export function parseStatusWebhook(payload: unknown): SendblueStatusWebhook {
  if (!isRecord(payload)) {
    throw new Error('Sendblue status payload must be an object');
  }

  const status = parseSendblueStatus(payload.status);
  if (!status) {
    throw new Error('Missing or invalid Sendblue status');
  }

  return {
    messageHandle: readString(payload, 'message_handle', { requireNonEmpty: true })!,
    status,
    errorCode: readString(payload, 'error_code'),
    errorMessage: readString(payload, 'error_message'),
    errorDetail: readString(payload, 'error_detail'),
    errorReason: readString(payload, 'error_reason'),
    wasDowngraded: readNullableBoolean(payload, 'was_downgraded'),
    service: readString(payload, 'service'),
    fromNumber: readString(payload, 'from_number'),
    toNumber: readString(payload, 'to_number'),
    number: readString(payload, 'number') ?? null,
    accountEmail: readString(payload, 'accountEmail') ?? null,
    plan: readString(payload, 'plan') ?? null,
    dateSent: readString(payload, 'date_sent') ?? null,
    dateUpdated: readString(payload, 'date_updated') ?? null,
    groupId: readString(payload, 'group_id') ?? null,
    senderEmail: readString(payload, 'sender_email') ?? null,
    seatId: readString(payload, 'seat_id') ?? null,
    raw: payload
  };
}

/**
 * Parses a Sendblue operational webhook (`call_log`, `line_blocked`,
 * `line_assigned`, `contact_created`) into a normalized
 * {@link SendblueOperationalWebhook}.
 *
 * Sendblue does not document concrete payload shapes for `line_blocked`,
 * `line_assigned`, or `contact_created` — only `call_log` and the shared
 * message envelope are specified — so this parser is intentionally
 * permissive. The full payload is preserved on `raw` for downstream
 * handlers, and a small set of commonly-present fields is hoisted onto the
 * normalized result.
 *
 * Reference:
 *  - https://docs.sendblue.com/getting-started/webhooks
 */
export function parseOperationalWebhook(payload: unknown): SendblueOperationalWebhook {
  if (!isRecord(payload)) {
    throw new Error('Sendblue operational webhook payload must be an object');
  }

  return {
    eventType: readString(payload, 'event_type'),
    messageHandle: readString(payload, 'message_handle'),
    fromNumber: readString(payload, 'from_number'),
    toNumber: readString(payload, 'to_number'),
    number: readString(payload, 'number'),
    status: readString(payload, 'status'),
    content: readString(payload, 'content'),
    raw: payload
  };
}

export type SendblueTypingIndicatorWebhook = {
  number: string;
  fromNumber: string;
  isTyping: boolean;
  timestamp?: string;
  raw: Record<string, unknown>;
};

/**
 * Parses a Sendblue `typing_indicator` inbound webhook into a normalized
 * {@link SendblueTypingIndicatorWebhook}.
 *
 * Per Sendblue docs the payload contains `number` (the contact who is
 * typing), `from_number` (the Sendblue line that received the indicator),
 * `is_typing`, and an ISO-8601 `timestamp`. Inbound typing is iMessage-only
 * and the operational `typing_indicator` webhook registration is
 * account/API-gated — some accounts reject or drop registration even though
 * the docs list the type — so this parser is preserved and documented even
 * if the account never delivers traffic.
 *
 * Reference:
 *  - https://docs.sendblue.com/api-v2/typing-indicators
 */
export function parseTypingIndicatorWebhook(payload: unknown): SendblueTypingIndicatorWebhook {
  if (!isRecord(payload)) {
    throw new Error('Sendblue typing indicator payload must be an object');
  }

  return {
    number: readString(payload, 'number', { requireNonEmpty: true })!,
    fromNumber: readString(payload, 'from_number', { requireNonEmpty: true })!,
    isTyping: readBoolean(payload, 'is_typing'),
    timestamp: readString(payload, 'timestamp'),
    raw: payload
  };
}
