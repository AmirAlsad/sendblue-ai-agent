import type { SendblueReceiveWebhook } from '../sendblue/types.js';

export type ChatEndpointRequest = {
  message: string;
  fromNumber: string;
  toNumber: string;
  messageHandle: string;
  channel: 'imessage' | 'sms' | 'unknown';
  messages?: ChatEndpointMessage[];
  conversation?: {
    key: string;
    type: 'direct';
    lineNumber: string;
    phoneNumber: string;
    channel: 'imessage' | 'sms' | 'rcs' | 'unknown';
    smsDowngraded: boolean;
    state: string;
  };
  identity?: {
    userId: string;
    data?: unknown;
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
  | { silence: true }
  | { messages: string[]; silence?: false };

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
