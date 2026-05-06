import type { ChatEndpointRequest } from '../chat/types.js';
import type { ConversationRecord, InboundMessageItem } from './types.js';

export function aggregateMessageText(messages: InboundMessageItem[]): string {
  return messages.map(message => message.content).join('\n---\n');
}

export function createBufferedChatRequest(state: ConversationRecord): ChatEndpointRequest {
  const first = state.inboundBuffer[0];
  const message = aggregateMessageText(state.inboundBuffer);

  return {
    message,
    fromNumber: state.phoneNumber,
    toNumber: state.lineNumber,
    messageHandle: first?.messageHandle ?? '',
    channel: state.channel === 'rcs' ? 'unknown' : state.channel,
    messages: state.inboundBuffer.map(item => ({
      content: item.content,
      fromNumber: item.fromNumber,
      toNumber: item.toNumber,
      messageHandle: item.messageHandle,
      channel: item.channel,
      mediaUrl: item.mediaUrl,
      messageType: item.messageType,
      sendStyle: item.sendStyle,
      raw: item.raw
    })),
    conversation: {
      key: state.key,
      type: 'direct',
      lineNumber: state.lineNumber,
      phoneNumber: state.phoneNumber,
      channel: state.channel,
      smsDowngraded: state.smsDowngraded,
      state: state.state
    },
    identity: state.identity ?? null,
    typing: state.typing
      ? {
          isTyping: state.typing.isTyping,
          timestamp: state.typing.timestamp,
          receivedAt: state.typing.receivedAt
        }
      : null,
    sendblue: {
      wasDowngraded: first?.wasDowngraded ?? state.smsDowngraded,
      service: first?.service,
      mediaUrl: first?.mediaUrl,
      groupId: null,
      groupDisplayName: null,
      participants: undefined,
      sendStyle: first?.sendStyle,
      messageType: first?.messageType,
      raw: first?.raw ?? {}
    }
  };
}
