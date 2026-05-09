import type { ConversationRecord, InboundMessageItem, OutboundMessageItem } from '../conversation/types.js';
import type { StatusRecord } from '../status/tracker.js';

const REDACTED_CONTENT_PREFIX = '[redacted len=';
const ALREADY_REDACTED_PHONE = /^\+1?\*+\d{0,4}$/;

/**
 * Mask a phone number, preserving the leading "+" and the trailing 4 digits.
 * Idempotent on already-redacted values.
 */
export function redactPhone(phone: string | null | undefined): string {
  if (typeof phone !== 'string') return '';
  const trimmed = phone.trim();
  if (trimmed === '') return '';
  if (ALREADY_REDACTED_PHONE.test(trimmed)) return trimmed;
  const digits = trimmed.replace(/[^0-9]/g, '');
  if (digits.length <= 4) {
    return trimmed.startsWith('+') ? '+****' : '****';
  }
  const tail = digits.slice(-4);
  const stars = '*'.repeat(Math.max(1, digits.length - 4));
  return (trimmed.startsWith('+') ? '+' : '') + stars + tail;
}

/**
 * Replace message content with a length-only sentinel. Idempotent on values
 * already in `[redacted len=N]` form.
 */
export function redactContent(content: string | null | undefined): string {
  if (typeof content !== 'string') return '';
  if (content.startsWith(REDACTED_CONTENT_PREFIX) && content.endsWith(']')) return content;
  return `${REDACTED_CONTENT_PREFIX}${content.length}]`;
}

export function redactConversationRecord(record: ConversationRecord): ConversationRecord {
  return {
    ...record,
    key: redactKey(record.key),
    lineNumber: redactPhone(record.lineNumber),
    phoneNumber: redactPhone(record.phoneNumber),
    groupDisplayName: record.groupDisplayName ? redactName(record.groupDisplayName) : record.groupDisplayName,
    inboundBuffer: record.inboundBuffer.map(redactInboundItem),
    lateArrivals: record.lateArrivals.map(redactInboundItem),
    outboundQueue: record.outboundQueue.map(redactOutboundItem),
    deliveredMessages: record.deliveredMessages.map(redactContent),
    cancelledMessages: record.cancelledMessages.map(redactContent),
    typing: record.typing
      ? {
          ...record.typing,
          number: redactPhone(record.typing.number),
          fromNumber: redactPhone(record.typing.fromNumber)
        }
      : record.typing,
    identity: record.identity ? redactIdentity(record.identity) : record.identity,
    participants: record.participants
      ? redactParticipants(record.participants)
      : record.participants
  };
}

function redactIdentity(identity: NonNullable<ConversationRecord['identity']>): NonNullable<ConversationRecord['identity']> {
  return {
    ...identity,
    // userId is caller-supplied and may itself be a phone number, email, or
    // any other identifier — content-redact rather than echoing back.
    userId: identity.userId ? redactContent(identity.userId) : identity.userId,
    // data is typed as `unknown`; resolvers commonly stash the full lookup
    // payload here (full names, addresses, etc.). Drop entirely under default
    // redaction; ?reveal=true returns the original record so operators with
    // explicit intent still get the raw value.
    data: identity.data === undefined ? identity.data : '[redacted]',
    firstName: identity.firstName ? redactName(identity.firstName) : identity.firstName,
    lastName: identity.lastName ? redactName(identity.lastName) : identity.lastName,
    tags: identity.tags ? identity.tags.map(redactContent) : identity.tags,
    customVariables: identity.customVariables
      ? Object.fromEntries(
          Object.entries(identity.customVariables).map(([k, v]) => [k, redactContent(v)])
        )
      : identity.customVariables
  };
}

export function redactStatusRecord(record: StatusRecord): StatusRecord {
  return {
    ...record,
    errorMessage: record.errorMessage ? redactContent(record.errorMessage) : record.errorMessage,
    errorDetail: record.errorDetail ? redactContent(record.errorDetail) : record.errorDetail,
    events: record.events.map(event => ({
      ...event,
      errorMessage: event.errorMessage ? redactContent(event.errorMessage) : event.errorMessage,
      errorDetail: event.errorDetail ? redactContent(event.errorDetail) : event.errorDetail
    }))
  };
}

function redactInboundItem(item: InboundMessageItem): InboundMessageItem {
  return {
    ...item,
    content: redactContent(item.content),
    fromNumber: redactPhone(item.fromNumber),
    toNumber: redactPhone(item.toNumber)
  };
}

function redactOutboundItem(item: OutboundMessageItem): OutboundMessageItem {
  return {
    ...item,
    content: item.content ? redactContent(item.content) : item.content,
    // replyTo can carry quoted user text in some chat-action shapes; mediaUrl
    // is a hosted URL that may embed phone numbers in path/query components
    // depending on how the operator generates it. Redact both.
    replyTo: item.replyTo ? redactContent(item.replyTo) : item.replyTo,
    mediaUrl: item.mediaUrl ? redactContent(item.mediaUrl) : item.mediaUrl
  };
}

function redactParticipants(participants: unknown): unknown {
  if (Array.isArray(participants)) {
    return participants.map(p => {
      if (typeof p === 'string') return redactPhone(p);
      if (p && typeof p === 'object') {
        const record = p as Record<string, unknown>;
        const out: Record<string, unknown> = { ...record };
        for (const key of ['number', 'phoneNumber', 'phone']) {
          const value = record[key];
          if (typeof value === 'string') out[key] = redactPhone(value);
        }
        return out;
      }
      return p;
    });
  }
  return participants;
}

function redactName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === '') return '';
  return `${trimmed[0]}***`;
}

function redactKey(key: string): string {
  // direct:{line}:{phone} or group:{line}:{groupId}
  const parts = key.split(':');
  if (parts.length !== 3) return key;
  const [kind, line, tail] = parts;
  if (kind === 'direct') return `direct:${redactPhone(line)}:${redactPhone(tail)}`;
  if (kind === 'group') return `group:${redactPhone(line)}:${tail}`;
  return key;
}
