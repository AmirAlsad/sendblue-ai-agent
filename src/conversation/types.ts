import type { ChatEndpointMessage } from '../chat/types.js';
import type { SendblueReceiveWebhook } from '../sendblue/types.js';

export type ConversationStateName = 'idle' | 'buffering' | 'processing' | 'sending';
export type ConversationChannel = 'imessage' | 'sms' | 'rcs' | 'unknown';

export type ConversationIdentity = {
  userId: string;
  data?: unknown;
};

export type InboundMessageItem = ChatEndpointMessage & {
  wasDowngraded: boolean;
  service?: string;
  receivedAt: string;
};

export type OutboundMessageItem = {
  id: string;
  content: string;
  messageHandle?: string;
  sentAt?: string;
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
  type: 'direct';
  lineNumber: string;
  phoneNumber: string;
  channel: ConversationChannel;
  smsDowngraded: boolean;
  inboundBuffer: InboundMessageItem[];
  lateArrivals: InboundMessageItem[];
  outboundQueue: OutboundMessageItem[];
  deliveredMessages: string[];
  cancelledMessages: string[];
  currentOutboundIndex: number;
  currentOutboundHandle?: string;
  reprocessCount: number;
  identity?: ConversationIdentity | null;
  typing?: ConversationTypingState | null;
  lastActivity: number;
};

export type OutboundHandleMapping = {
  conversationKey: string;
  messageIndex: number;
};

export function directConversationKey(lineNumber: string, phoneNumber: string): string {
  return `direct:${lineNumber}:${phoneNumber}`;
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
  lineNumber: string;
  phoneNumber: string;
  channel?: ConversationChannel;
  smsDowngraded?: boolean;
  identity?: ConversationIdentity | null;
  typing?: ConversationTypingState | null;
  now?: number;
}): ConversationRecord {
  return {
    key: input.key,
    state: 'idle',
    type: 'direct',
    lineNumber: input.lineNumber,
    phoneNumber: input.phoneNumber,
    channel: input.channel ?? 'unknown',
    smsDowngraded: input.smsDowngraded ?? false,
    inboundBuffer: [],
    lateArrivals: [],
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
