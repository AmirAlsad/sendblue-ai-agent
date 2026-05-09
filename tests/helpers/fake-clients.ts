import type { ChatClient } from '../../src/chat/client.js';
import type { ChatEndpointRequest, ChatEndpointResponse } from '../../src/chat/types.js';
import type { SendblueClient } from '../../src/sendblue/client.js';
import type {
  SendblueActionResult,
  SendblueContactRequest,
  SendblueContactResult,
  SendblueMarkReadRequest,
  SendblueOutboundGroupMessage,
  SendblueOutboundMessage,
  SendblueReactionRequest,
  SendblueSendResult,
  SendblueTypingIndicator,
  SendblueTypingIndicatorResult
} from '../../src/sendblue/types.js';

export class FakeChatClient implements ChatClient {
  calls: ChatEndpointRequest[] = [];
  nextResponse: ChatEndpointResponse = { messages: ['default reply'] };
  nextError: Error | undefined;

  async complete(req: ChatEndpointRequest): Promise<ChatEndpointResponse> {
    this.calls.push(req);
    if (this.nextError) throw this.nextError;
    return this.nextResponse;
  }
}

export class FakeSendblueClient implements SendblueClient {
  sendCalls: SendblueOutboundMessage[] = [];
  groupCalls: SendblueOutboundGroupMessage[] = [];
  reactionCalls: SendblueReactionRequest[] = [];
  markReadCalls: SendblueMarkReadRequest[] = [];
  typingCalls: SendblueTypingIndicator[] = [];
  contactCalls: SendblueContactRequest[] = [];
  failNextSend: Error | undefined;
  nextSendHandle: string | undefined;

  async sendMessage(message: SendblueOutboundMessage): Promise<SendblueSendResult> {
    this.sendCalls.push(message);
    if (this.failNextSend) {
      const err = this.failNextSend;
      this.failNextSend = undefined;
      throw err;
    }
    const handle = this.nextSendHandle ?? `sent-${this.sendCalls.length}`;
    this.nextSendHandle = undefined;
    return { messageHandle: handle, raw: { ok: true } };
  }

  async sendGroupMessage(message: SendblueOutboundGroupMessage): Promise<SendblueSendResult> {
    this.groupCalls.push(message);
    return { messageHandle: `group-${message.groupId}-${this.groupCalls.length}`, raw: { ok: true } };
  }

  async sendReaction(reaction: SendblueReactionRequest): Promise<SendblueActionResult> {
    this.reactionCalls.push(reaction);
    return {
      status: 'OK',
      messageHandle: reaction.messageHandle,
      reaction: reaction.reaction,
      raw: { ok: true }
    };
  }

  async markRead(receipt: SendblueMarkReadRequest): Promise<SendblueActionResult> {
    this.markReadCalls.push(receipt);
    return { status: 'OK', raw: { ok: true } };
  }

  async sendTypingIndicator(
    indicator: SendblueTypingIndicator
  ): Promise<SendblueTypingIndicatorResult> {
    this.typingCalls.push(indicator);
    return { raw: { ok: true } };
  }

  async createContact(contact: SendblueContactRequest): Promise<SendblueContactResult> {
    this.contactCalls.push(contact);
    return { raw: { ok: true } };
  }
}
