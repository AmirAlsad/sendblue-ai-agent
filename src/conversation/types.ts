import type { ChatEndpointMessage } from '../chat/types.js';
import type { SendblueReaction, SendblueReceiveWebhook, SendblueSendStyle } from '../sendblue/types.js';

export type ConversationStateName = 'idle' | 'buffering' | 'processing' | 'sending';
export type ConversationChannel = 'imessage' | 'sms' | 'rcs' | 'unknown';
export type ConversationType = 'direct' | 'group';
export type RichOutboundActionKind = 'message' | 'media' | 'reply' | 'reaction' | 'silence';

export type ConversationIdentity = {
  userId: string;
  data?: unknown;
  authorized?: boolean;
  /**
   * Optional display-name fields surfaced to operator-managed surfaces (e.g.
   * Sendblue's account-level Contacts API). Forwarded verbatim by
   * `src/sendblue/contacts.ts` when contact upsert is enabled. Either field
   * being non-empty is enough for an upsert; resolvers may return only one.
   */
  firstName?: string;
  lastName?: string;
  /** Optional Sendblue contact tags (e.g. `["agent-line:+1555…","tier:gold"]`). */
  tags?: string[];
  /** Optional Sendblue contact `custom_variables` map. Values are strings per docs. */
  customVariables?: Record<string, string>;
};

export type InboundMessageItem = ChatEndpointMessage & {
  wasDowngraded: boolean;
  service?: string;
  receivedAt: string;
};

export type OutboundMessageItem = {
  id: string;
  kind: RichOutboundActionKind;
  content?: string;
  mediaUrl?: string;
  sendStyle?: SendblueSendStyle;
  replyTo?: string;
  reaction?: SendblueReaction;
  partIndex?: number;
  targetMessageHandle?: string;
  messageHandle?: string;
  sentAt?: string;
  skippedAt?: string;
  skipReason?: string;
  /**
   * Number of transient-error retries already attempted for this queued
   * action. Capped at `transientRetryMaxAttempts`. Persisted on the
   * conversation record so retry state survives status-callback hops and
   * (with Redis) process restarts.
   */
  retryCount?: number;
  /** ISO timestamp of the next scheduled retry attempt, when stalled. */
  nextRetryAt?: string;
};

export type ConversationTypingState = {
  isTyping: boolean;
  number: string;
  fromNumber: string;
  timestamp?: string;
  receivedAt: string;
};

export type ConversationRecord = {
  key: string;
  state: ConversationStateName;
  type: ConversationType;
  lineNumber: string;
  phoneNumber: string;
  groupId?: string | null;
  groupDisplayName?: string | null;
  participants?: unknown;
  channel: ConversationChannel;
  smsDowngraded: boolean;
  inboundBuffer: InboundMessageItem[];
  lateArrivals: InboundMessageItem[];
  lastInboundMessageHandles: string[];
  outboundQueue: OutboundMessageItem[];
  deliveredMessages: string[];
  cancelledMessages: string[];
  currentOutboundIndex: number;
  currentOutboundHandle?: string;
  reprocessCount: number;
  identity?: ConversationIdentity | null;
  typing?: ConversationTypingState | null;
  /**
   * ISO timestamp of the most recent inbound message on this conversation.
   * Used to classify outbound as "in 24h reply window" (free under the Agent
   * plan) vs "follow-up" (counts toward the 200/day follow-up cap). Not the
   * same as `lastActivity`, which also advances on outbound and status
   * callbacks.
   */
  lastInboundAt?: string;
  lastActivity: number;
  /**
   * Optional request-scoped trace identifier captured at the inbound webhook
   * entry. Status callbacks recover it from the outbound handle mapping so
   * follow-up logs can correlate to the original conversation event.
   */
  traceId?: string;
};

export type OutboundHandleMapping = {
  conversationKey: string;
  messageIndex: number;
  /** Conversation traceId at the time this outbound was sent. */
  traceId?: string;
};

export function directConversationKey(lineNumber: string, phoneNumber: string): string {
  return `direct:${lineNumber}:${phoneNumber}`;
}

export function groupConversationKey(lineNumber: string, groupId: string): string {
  return `group:${lineNumber}:${groupId}`;
}

export function channelFromSendblue(webhook: Pick<SendblueReceiveWebhook, 'service' | 'wasDowngraded'>): ConversationChannel {
  if (webhook.wasDowngraded === true) return 'sms';
  if (webhook.service === 'SMS') return 'sms';
  if (webhook.service === 'RCS') return 'rcs';
  if (webhook.service === 'iMessage') return 'imessage';
  return 'unknown';
}

export function createIdleConversation(input: {
  key: string;
  type?: ConversationType;
  lineNumber: string;
  phoneNumber: string;
  groupId?: string | null;
  groupDisplayName?: string | null;
  participants?: unknown;
  channel?: ConversationChannel;
  smsDowngraded?: boolean;
  identity?: ConversationIdentity | null;
  typing?: ConversationTypingState | null;
  now?: number;
}): ConversationRecord {
  return {
    key: input.key,
    state: 'idle',
    type: input.type ?? 'direct',
    lineNumber: input.lineNumber,
    phoneNumber: input.phoneNumber,
    groupId: input.groupId,
    groupDisplayName: input.groupDisplayName,
    participants: input.participants,
    channel: input.channel ?? 'unknown',
    smsDowngraded: input.smsDowngraded ?? false,
    inboundBuffer: [],
    lateArrivals: [],
    lastInboundMessageHandles: [],
    outboundQueue: [],
    deliveredMessages: [],
    cancelledMessages: [],
    currentOutboundIndex: 0,
    currentOutboundHandle: undefined,
    reprocessCount: 0,
    identity: input.identity,
    typing: input.typing,
    lastActivity: input.now ?? Date.now()
  };
}
