export const SENDBLUE_STATUSES = [
  'REGISTERED',
  'PENDING',
  'DECLINED',
  'QUEUED',
  'ACCEPTED',
  'SENT',
  'DELIVERED',
  'ERROR'
] as const;

export type SendblueStatus = (typeof SENDBLUE_STATUSES)[number];

export type SendblueReceiveStatus = SendblueStatus | 'RECEIVED';

export const SENDBLUE_SEND_STYLES = [
  'celebration',
  'shooting_star',
  'fireworks',
  'lasers',
  'love',
  'confetti',
  'balloons',
  'spotlight',
  'echo',
  'invisible',
  'gentle',
  'loud',
  'slam'
] as const;

export type SendblueSendStyle = (typeof SENDBLUE_SEND_STYLES)[number];

export const SENDBLUE_REACTIONS = [
  'love',
  'like',
  'dislike',
  'laugh',
  'emphasize',
  'question'
] as const;

export type SendblueReaction = (typeof SENDBLUE_REACTIONS)[number];

export const SENDBLUE_ERROR_CODES = [
  '4000',
  '4001',
  '4002',
  '5000',
  '5003',
  '5509',
  '10001',
  '10002',
  'SMS_LIMIT_REACHED'
] as const;

export type SendblueErrorCode = (typeof SENDBLUE_ERROR_CODES)[number];

/**
 * Normalized inbound `receive` webhook payload.
 *
 * Required fields are kept narrow on purpose: only what the conversation
 * router needs (`fromNumber`, `toNumber`, `messageHandle`, and a string
 * `content`). Everything else Sendblue documents is surfaced as optional or
 * nullable structured fields, and the full unmodified payload is preserved
 * on `raw` for forward compatibility (reply/reaction metadata, future
 * fields, account-specific extensions).
 */
export type SendblueReceiveWebhook = {
  content: string;
  fromNumber: string;
  toNumber: string;
  messageHandle: string;
  isOutbound: boolean;
  status?: SendblueReceiveStatus;
  wasDowngraded: boolean | null;
  service?: string;
  mediaUrl?: string | null;
  groupId?: string | null;
  groupDisplayName?: string | null;
  sendblueNumber?: string | null;
  participants?: unknown;
  sendStyle?: string | null;
  messageType?: string | null;
  /** Sendblue end-user phone number (E.164). Documented alongside `from_number`. */
  number?: string | null;
  /** Account email associated with the receiving Sendblue line. */
  accountEmail?: string | null;
  /** Sendblue plan value (e.g. `"dedicated"`). */
  plan?: string | null;
  /** Whether the contact has opted out of receiving messages. */
  optedOut?: boolean | null;
  /** ISO-8601 timestamp Sendblue received/sent the message. */
  dateSent?: string | null;
  /** ISO-8601 timestamp Sendblue last updated the message. */
  dateUpdated?: string | null;
  /** Email of the seat that originated the message (typically null on inbound). */
  senderEmail?: string | null;
  /** UUID of the seat that originated the message (typically null on inbound). */
  seatId?: string | null;
  /** Documented Sendblue error code for the status (string in payload). */
  errorCode?: string;
  errorMessage?: string;
  errorDetail?: string;
  /** Free-form error context — distinct from `errorMessage`/`errorDetail`. */
  errorReason?: string;
  raw: Record<string, unknown>;
};

/**
 * Normalized outbound message status callback payload.
 *
 * Status callbacks share the receive envelope shape, so most documented
 * receive fields are also surfaced here for diagnostics. Only `messageHandle`
 * and a documented `status` value are required; missing or invalid `status`
 * (including `READ` and `RECEIVED`) results in a parse error.
 */
export type SendblueStatusWebhook = {
  messageHandle: string;
  status: SendblueStatus;
  errorCode?: string;
  errorMessage?: string;
  errorDetail?: string;
  errorReason?: string;
  wasDowngraded?: boolean | null;
  service?: string;
  fromNumber?: string;
  toNumber?: string;
  number?: string | null;
  accountEmail?: string | null;
  plan?: string | null;
  dateSent?: string | null;
  dateUpdated?: string | null;
  groupId?: string | null;
  senderEmail?: string | null;
  seatId?: string | null;
  raw: Record<string, unknown>;
};

/**
 * Permissive normalized shape for Sendblue operational webhooks
 * (`call_log`, `line_blocked`, `line_assigned`, `contact_created`).
 *
 * Only `call_log` has a documented payload schema; the other operational
 * webhooks are listed as supported types but Sendblue does not publish
 * field-level documentation, so we deliberately keep this loose and
 * preserve the full payload on `raw`.
 */
export type SendblueOperationalWebhook = {
  raw: Record<string, unknown>;
  /** Present on `call_log` payloads (e.g. `"call_log"`). May be absent. */
  eventType?: string;
  messageHandle?: string;
  fromNumber?: string;
  toNumber?: string;
  number?: string;
  status?: string;
  content?: string;
};

export type SendblueOutboundMessage = {
  toNumber: string;
  content: string;
  statusCallback: string;
  mediaUrl?: string;
  sendStyle?: SendblueSendStyle;
  /**
   * Optional Sendblue seat id (UUID or Firebase Auth subject).
   * Documented at https://docs.sendblue.com/api/resources/messages/methods/send/.
   * Required for multi-seat outbound attribution.
   */
  seatId?: string;
};

export type SendblueOutboundGroupMessage = {
  groupId: string;
  content: string;
  statusCallback?: string;
  mediaUrl?: string;
  sendStyle?: SendblueSendStyle;
};

export type SendblueReactionRequest = {
  messageHandle: string;
  reaction: SendblueReaction;
  partIndex?: number;
};

export type SendblueMarkReadRequest = {
  toNumber: string;
};

export type SendblueTypingIndicator = {
  toNumber: string;
};

export type SendblueTypingIndicatorResult = {
  status?: string;
  errorMessage?: string | null;
  raw: unknown;
};

export type SendblueSendResult = {
  messageHandle?: string;
  raw: unknown;
};

export type SendblueActionResult = {
  status?: string;
  message?: string;
  errorCode?: string;
  errorMessage?: string | null;
  messageHandle?: string;
  reaction?: string;
  number?: string;
  raw: unknown;
};
