import type {
  SendblueReaction,
  SendblueReceiveWebhook,
  SendblueSendStyle
} from '../sendblue/types.js';

export type ChatResponseTagNames = {
  message: string;
  noResponse: string;
  reaction: string;
  reply: string;
};

export const DEFAULT_CHAT_RESPONSE_TAGS: ChatResponseTagNames = {
  message: 'message',
  noResponse: 'no_response',
  reaction: 'reaction',
  reply: 'reply'
};

export type TargetRef =
  | { messageHandle: string; partIndex?: number }
  | { alias: 'latest' | 'previous' | 'first' | 'last' | (string & {}); partIndex?: number }
  | { contentIncludes: string; occurrence?: 'first' | 'last'; partIndex?: number }
  | { content: string; partIndex?: number }
  | { partIndex: number };

export type ChatMessageAction = {
  type: 'message';
  content: string;
  mediaUrl?: string;
  sendStyle?: SendblueSendStyle;
};

export type ChatMediaAction = {
  type: 'media';
  mediaUrl: string;
  content?: string;
  sendStyle?: SendblueSendStyle;
};

export type ChatReplyAction = {
  type: 'reply';
  target: TargetRef;
  content: string;
  mediaUrl?: string;
  sendStyle?: SendblueSendStyle;
};

export type ChatReactionAction = {
  type: 'reaction';
  reaction: SendblueReaction;
  target: TargetRef;
};

export type ChatSilenceAction = {
  type: 'silence';
};

export type ChatAction =
  | ChatMessageAction
  | ChatMediaAction
  | ChatReplyAction
  | ChatReactionAction
  | ChatSilenceAction;

export type ChatContractWarning = {
  code: string;
  message: string;
  path?: string;
};

export type NormalizedChatEndpointResponse =
  | {
      actions: ChatAction[];
      silence?: false;
      warnings?: ChatContractWarning[];
    }
  | {
      actions: [];
      silence: true;
      warnings?: ChatContractWarning[];
    };

export type LegacyChatEndpointResponse =
  | { message: string; silence?: false }
  | { messages: string[]; silence?: false }
  | { silence: true };

export type ActionChatEndpointResponse = {
  actions: ChatAction[];
  silence?: false;
  warnings?: ChatContractWarning[];
};

export type ChatEndpointRequest = {
  message: string;
  fromNumber: string;
  toNumber: string;
  messageHandle: string;
  channel: 'imessage' | 'sms' | 'rcs' | 'unknown';
  messages?: ChatEndpointMessage[];
  conversation?: {
    key: string;
    type: 'direct' | 'group';
    lineNumber: string;
    phoneNumber?: string;
    groupId?: string | null;
    groupDisplayName?: string | null;
    participants?: unknown;
    channel: 'imessage' | 'sms' | 'rcs' | 'unknown';
    smsDowngraded: boolean;
    state: string;
    invocation?: {
      reason: 'direct' | 'name' | 'reaction' | 'reply';
      agentName?: string;
      targetMessageHandle?: string;
    };
  };
  identity?: {
    userId: string;
    data?: unknown;
    authorized?: boolean;
  } | null;
  typing?: {
    isTyping: boolean;
    timestamp?: string;
    receivedAt: string;
  } | null;
  sendblue: {
    wasDowngraded: boolean;
    service?: string;
    mediaUrl?: string | null;
    groupId?: string | null;
    groupDisplayName?: string | null;
    sendblueNumber?: string | null;
    participants?: unknown;
    sendStyle?: string | null;
    messageType?: string | null;
    raw: Record<string, unknown>;
  };
};

export type ChatEndpointMessage = {
  content: string;
  fromNumber: string;
  toNumber: string;
  messageHandle: string;
  channel: 'imessage' | 'sms' | 'rcs' | 'unknown';
  mediaUrl?: string | null;
  messageType?: string | null;
  sendStyle?: string | null;
  raw: Record<string, unknown>;
};

export type ChatEndpointResponse =
  | LegacyChatEndpointResponse
  | ActionChatEndpointResponse
  | NormalizedChatEndpointResponse;

export function createChatRequest(webhook: SendblueReceiveWebhook): ChatEndpointRequest {
  return {
    message: webhook.content,
    fromNumber: webhook.fromNumber,
    toNumber: webhook.toNumber,
    messageHandle: webhook.messageHandle,
    channel: webhook.wasDowngraded
      ? 'sms'
      : webhook.service === 'SMS'
        ? 'sms'
        : webhook.service === 'RCS'
          ? 'rcs'
          : webhook.service === 'iMessage'
            ? 'imessage'
            : 'unknown',
    sendblue: {
      wasDowngraded: webhook.wasDowngraded === true,
      service: webhook.service,
      mediaUrl: webhook.mediaUrl,
      groupId: webhook.groupId,
      groupDisplayName: webhook.groupDisplayName,
      sendblueNumber: webhook.sendblueNumber,
      participants: webhook.participants,
      sendStyle: webhook.sendStyle,
      messageType: webhook.messageType,
      raw: webhook.raw
    }
  };
}
