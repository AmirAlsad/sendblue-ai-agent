import type {
  SendblueErrorCode,
  SendblueStatus,
  SendblueStatusWebhook
} from '../sendblue/types.js';

/**
 * Per-message accumulated record of Sendblue status callbacks.
 *
 * Sendblue documents 8 status callback values: `REGISTERED`, `PENDING`,
 * `DECLINED`, `QUEUED`, `ACCEPTED`, `SENT`, `DELIVERED`, and `ERROR`.
 * `READ` is intentionally not part of this lifecycle — Sendblue exposes
 * read receipts as the outbound `POST /api/mark-read` endpoint, not as a
 * status callback. See `docs/features/status-tracking.md`.
 *
 * The record keeps a deduplicated history of status values plus a richer
 * `events[]` log that preserves the per-callback fields documented by
 * Sendblue (status, error fields, downgrade signal, service, raw payload).
 *
 * `terminalStatus` is the most recent terminal status observed
 * (`DELIVERED`, `DECLINED`, or `ERROR`). `SENT` is also terminal for SMS
 * and downgraded conversations, but the agent encodes that elsewhere
 * because terminality there is channel-aware.
 */
export type StatusRecord = {
  messageHandle: string;
  history: SendblueStatus[];
  events: StatusEvent[];
  terminalStatus?: SendblueStatus;
  errorCode?: string;
  errorMessage?: string;
  errorDetail?: string;
  errorReason?: string;
  errorCategory?: ErrorCodeCategory;
  wasDowngraded?: boolean | null;
  service?: string;
  lastService?: string;
  lastUpdatedAt?: string;
};

/**
 * One Sendblue status callback as seen by the tracker.
 *
 * Captures the channel/downgrade signal so consumers (e.g. the conversation
 * agent) can correlate status events with channel-aware advancement rules
 * without re-parsing the raw payload.
 */
export type StatusEvent = {
  status: SendblueStatus;
  errorCode?: string;
  errorMessage?: string;
  errorDetail?: string;
  errorReason?: string;
  wasDowngraded?: boolean | null;
  service?: string;
  receivedAt: string;
};

/**
 * Statuses that are unconditionally terminal for the tracker.
 *
 * Note: `SENT` is terminal for SMS and downgraded conversations per
 * Sendblue's documented lifecycle, but the conversation agent owns that
 * channel-aware decision. Keep this set conservative so the tracker
 * never claims a non-terminal `SENT` is final.
 */
export const TERMINAL_STATUSES = new Set<SendblueStatus>(['DELIVERED', 'DECLINED', 'ERROR']);

/**
 * Sendblue documented error code categories.
 *
 * These are derived from
 * https://docs.sendblue.com/getting-started/sending-messages and not from
 * SDK exports — Sendblue's TypeScript SDK does not expose constants for
 * these codes today.
 */
export type ErrorCodeCategory =
  | 'validation'
  | 'rate_limit'
  | 'blacklist'
  | 'server'
  | 'send_failed'
  | 'status_unresolved'
  | 'sms_limit'
  | 'unknown';

const ERROR_CODE_CATEGORIES: Record<string, ErrorCodeCategory> = {
  '4000': 'validation',
  '4001': 'rate_limit',
  '4002': 'blacklist',
  '5000': 'server',
  '5003': 'rate_limit',
  '5509': 'rate_limit',
  '10001': 'send_failed',
  '10002': 'status_unresolved',
  SMS_LIMIT_REACHED: 'sms_limit'
};

/**
 * Map a Sendblue error_code (numeric or named) to a semantic category.
 * Unknown codes return `'unknown'` rather than throwing — Sendblue may
 * emit codes the package does not yet enumerate.
 */
export function classifyErrorCode(code: string | number | undefined | null): ErrorCodeCategory {
  if (code === undefined || code === null) return 'unknown';
  const key = String(code);
  return ERROR_CODE_CATEGORIES[key] ?? 'unknown';
}

/**
 * Returns true when the error code semantically indicates a transient
 * condition the caller should respect (e.g. rate limiting, server errors,
 * SMS limits) versus a permanent rejection (validation, blacklist).
 *
 * Distinct from "downgrade" — downgrade is signaled by `was_downgraded`
 * on the receive/status callback, not by an error code.
 */
export function isTransientErrorCode(code: string | number | undefined | null): boolean {
  const category = classifyErrorCode(code);
  return (
    category === 'rate_limit' ||
    category === 'server' ||
    category === 'sms_limit' ||
    category === 'status_unresolved'
  );
}

/** Type guard for the documented Sendblue error code enumeration. */
export function isDocumentedErrorCode(code: string | number | undefined | null): code is SendblueErrorCode {
  if (code === undefined || code === null) return false;
  return Object.prototype.hasOwnProperty.call(ERROR_CODE_CATEGORIES, String(code));
}

export function createStatusRecord(messageHandle: string): StatusRecord {
  return {
    messageHandle,
    history: [],
    events: []
  };
}

/**
 * Apply a single Sendblue status callback to an existing (or absent) record
 * and return the updated record.
 *
 * The function is pure: it never mutates `existing`, so callers can replace
 * an entry in their store atomically.
 *
 * Behavior:
 * - Adjacent duplicate statuses are not appended to `history` (Sendblue
 *   may retry callbacks, and adjacent dupes are noise rather than signal).
 * - Every callback is appended to `events[]` so retry/dedupe and timeline
 *   diagnostics are preserved end-to-end.
 * - `was_downgraded`, once observed as `true`, is sticky on the record.
 *   This mirrors AGENTS.md: downgrade is conversation-significant state
 *   and must be preserved even if a later callback omits the field.
 * - Error fields are recorded on terminal `ERROR` statuses and also
 *   classified into a semantic category (`errorCategory`).
 */
export function applyStatusUpdate(
  existing: StatusRecord | undefined,
  update: SendblueStatusWebhook,
  options: { now?: () => Date } = {}
): StatusRecord {
  const now = options.now ?? (() => new Date());
  const receivedAt = now().toISOString();
  const record: StatusRecord = existing
    ? { ...existing, history: [...existing.history], events: [...(existing.events ?? [])] }
    : createStatusRecord(update.messageHandle);

  if (record.history.at(-1) !== update.status) {
    record.history.push(update.status);
  }

  record.events.push({
    status: update.status,
    errorCode: update.errorCode,
    errorMessage: update.errorMessage,
    errorDetail: update.errorDetail,
    errorReason: (update as SendblueStatusWebhook & { errorReason?: string }).errorReason,
    wasDowngraded: update.wasDowngraded ?? null,
    service: update.service,
    receivedAt
  });

  if (TERMINAL_STATUSES.has(update.status)) {
    record.terminalStatus = update.status;
  }

  if (update.status === 'ERROR') {
    record.errorCode = update.errorCode;
    record.errorMessage = update.errorMessage;
    record.errorDetail = update.errorDetail;
    record.errorReason = (update as SendblueStatusWebhook & { errorReason?: string }).errorReason;
    record.errorCategory = classifyErrorCode(update.errorCode);
  }

  // Sticky downgrade: once true, stay true for the lifetime of the record.
  if (update.wasDowngraded === true) {
    record.wasDowngraded = true;
  } else if (record.wasDowngraded === undefined && update.wasDowngraded !== undefined) {
    record.wasDowngraded = update.wasDowngraded;
  }

  if (update.service) {
    record.lastService = update.service;
    record.service ??= update.service;
  }

  record.lastUpdatedAt = receivedAt;

  return record;
}

/**
 * In-memory store for `StatusRecord` keyed by `message_handle`.
 *
 * This is the local/test path. The production conversation agent only
 * reads `record.terminalStatus`, `record.errorCode`, and `record.history`
 * for status-driven queue advancement; richer event consumers (operations
 * dashboards, retry workers) should read `record.events`.
 */
export class InMemoryStatusStore {
  private readonly records = new Map<string, StatusRecord>();

  apply(update: SendblueStatusWebhook): StatusRecord {
    const next = applyStatusUpdate(this.records.get(update.messageHandle), update);
    this.records.set(update.messageHandle, next);
    return next;
  }

  get(messageHandle: string): StatusRecord | undefined {
    return this.records.get(messageHandle);
  }

  all(): StatusRecord[] {
    return Array.from(this.records.values());
  }

  clear(): void {
    this.records.clear();
  }
}
