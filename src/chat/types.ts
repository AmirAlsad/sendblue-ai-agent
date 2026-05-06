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

/**
 * Selector for an inbound message in the conversation buffer.
 * `messageHandle` is the most reliable form (Sendblue's Apple GUID from inbound webhooks).
 * Aliases supported by `target-resolver.ts`: `last|latest|current`, `first|oldest`, `previous|prior`,
 * plus any per-message `aliases[]` entry.
 */
export type TargetRef =
  | { messageHandle: string; partIndex?: number }
  | {
      alias:
        | 'latest'
        | 'last'
        | 'current'
        | 'previous'
        | 'prior'
        | 'first'
        | 'oldest'
        | (string & {});
      partIndex?: number;
    }
  | { contentIncludes: string; occurrence?: 'first' | 'last'; partIndex?: number }
  | { content: string; partIndex?: number }
  | { partIndex: number };

/**
 * Plain text or text+media outbound. `sendStyle` is iMessage-only and is
 * dropped by the conversation agent on SMS/RCS/downgraded conversations.
 * See https://docs.sendblue.com/api/resources/messages/methods/send/
 */
export type ChatMessageAction = {
  type: 'message';
  content: string;
  mediaUrl?: string;
  sendStyle?: SendblueSendStyle;
};

/**
 * Media-first outbound (vCard contact card, image, video). `mediaUrl` must be
 * a publicly fetchable HTTPS URL hosted by the developer's application —
 * Sendblue fetches it at send time. `sendStyle` is iMessage-only.
 */
export type ChatMediaAction = {
  type: 'media';
  mediaUrl: string;
  content?: string;
  sendStyle?: SendblueSendStyle;
};

/**
 * Contextual reply intent. The Sendblue direct send API does not currently
 * expose a native reply target parameter, so the conversation agent delivers
 * this as a normal message and logs the resolved target. Once Sendblue
 * exposes native replies the action shape stays stable for callers.
 */
export type ChatReplyAction = {
  type: 'reply';
  target: TargetRef;
  content: string;
  mediaUrl?: string;
  sendStyle?: SendblueSendStyle;
};

/**
 * Tapback reaction. iMessage-only per Sendblue
 * (https://docs.sendblue.com/api-v2/reactions/). Suppressed on SMS, RCS, and
 * downgraded conversations.
 */
export type ChatReactionAction = {
  type: 'reaction';
  reaction: SendblueReaction;
  target: TargetRef;
};

/**
 * Acknowledge the inbound turn without sending. No outbound transport call.
 * Mutually exclusive with any other action in the same response — the
 * normalizer drops any response that mixes silence with outbound actions.
 */
export type ChatSilenceAction = {
  type: 'silence';
};

export type ChatAction =
  | ChatMessageAction
  | ChatMediaAction
  | ChatReplyAction
  | ChatReactionAction
  | ChatSilenceAction;

/**
 * Action types that are iMessage-only at the Sendblue transport layer.
 * The conversation agent uses a channel/downgrade check (see
 * `supportsImessageRichAction`) to suppress or degrade these on SMS/RCS/
 * downgraded conversations. Send effects (`sendStyle` on message/media/reply)
 * are also iMessage-only but are degraded inline rather than dropping the
 * whole action.
 */
export const IMESSAGE_ONLY_ACTION_TYPES = ['reaction'] as const;
export type ImessageOnlyActionType = (typeof IMESSAGE_ONLY_ACTION_TYPES)[number];

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
