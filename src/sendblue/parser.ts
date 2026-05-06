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

function readString(
  payload: Record<string, unknown>,
  key: string,
  { required = false } = {}
): string | undefined {
  const value = payload[key];
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed || !required) return value;
  }
  if (required) throw new Error(`Missing required Sendblue field: ${key}`);
  return undefined;
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

export function parseReceiveWebhook(payload: unknown): SendblueReceiveWebhook {
  if (!isRecord(payload)) {
    throw new Error('Sendblue webhook payload must be an object');
  }

  return {
    content: readString(payload, 'content', { required: true })!,
    fromNumber: readString(payload, 'from_number', { required: true })!,
    toNumber: readString(payload, 'to_number', { required: true })!,
    messageHandle: readString(payload, 'message_handle', { required: true })!,
    isOutbound: readBoolean(payload, 'is_outbound'),
    status: parseReceiveStatus(payload.status),
    wasDowngraded: readNullableBoolean(payload, 'was_downgraded'),
    service: readString(payload, 'service'),
    mediaUrl: readString(payload, 'media_url') ?? null,
    groupId: readString(payload, 'group_id') ?? null,
    groupDisplayName: readString(payload, 'group_display_name') ?? null,
    sendblueNumber: readString(payload, 'sendblue_number') ?? null,
    participants: payload.participants,
    sendStyle: readString(payload, 'send_style') ?? null,
    messageType: readString(payload, 'message_type') ?? null,
    raw: payload
  };
}

export function parseStatusWebhook(payload: unknown): SendblueStatusWebhook {
  if (!isRecord(payload)) {
    throw new Error('Sendblue status payload must be an object');
  }

  const status = parseSendblueStatus(payload.status);
  if (!status) {
    throw new Error('Missing or invalid Sendblue status');
  }

  return {
    messageHandle: readString(payload, 'message_handle', { required: true })!,
    status,
    errorCode: readString(payload, 'error_code'),
    errorMessage: readString(payload, 'error_message'),
    errorDetail: readString(payload, 'error_detail'),
    wasDowngraded: readNullableBoolean(payload, 'was_downgraded'),
    service: readString(payload, 'service'),
    raw: payload
  };
}

export function parseOperationalWebhook(payload: unknown): SendblueOperationalWebhook {
  if (!isRecord(payload)) {
    throw new Error('Sendblue operational webhook payload must be an object');
  }

  return {
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

export function parseTypingIndicatorWebhook(payload: unknown): SendblueTypingIndicatorWebhook {
  if (!isRecord(payload)) {
    throw new Error('Sendblue typing indicator payload must be an object');
  }

  return {
    number: readString(payload, 'number', { required: true })!,
    fromNumber: readString(payload, 'from_number', { required: true })!,
    isTyping: readBoolean(payload, 'is_typing'),
    timestamp: readString(payload, 'timestamp'),
    raw: payload
  };
}
