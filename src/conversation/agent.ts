import type pino from 'pino';
import type { ChatClient } from '../chat/client.js';
import type { ChatEndpointResponse } from '../chat/types.js';
import type { AgentConfig } from '../config/env.js';
import type { IdentityResolver } from '../identity/resolver.js';
import type { SendblueClient } from '../sendblue/client.js';
import type {
  SendblueReceiveWebhook,
  SendblueStatusWebhook,
  SendblueTypingIndicatorResult
} from '../sendblue/types.js';
import type { InMemoryStatusStore } from '../status/tracker.js';
import { calculateBufferTimeout, truncateCancelledMessage } from './buffering.js';
import { createBufferedChatRequest } from './chat-request.js';
import type { BufferScheduler } from './scheduler.js';
import type { ConversationStore } from './store.js';
import {
  channelFromSendblue,
  createIdleConversation,
  directConversationKey,
  type ConversationChannel,
  type ConversationRecord,
  type ConversationTypingState,
  type InboundMessageItem,
  type OutboundMessageItem
} from './types.js';

export type ReceiveWebhookResult =
  | { ok: true; duplicate: true }
  | { ok: true; group: true; accepted: false }
  | { ok: true; conversationKey: string; state: ConversationRecord['state']; accepted: true };

export type TypingWebhookInput = {
  number: string;
  fromNumber: string;
  isTyping: boolean;
  timestamp?: string;
};

export class ConversationAgent {
  private readonly deliveryTimeouts = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly deps: {
      config: AgentConfig;
      chatClient: ChatClient;
      sendblueClient: SendblueClient;
      statusStore: InMemoryStatusStore;
      store: ConversationStore;
      scheduler: BufferScheduler;
      identityResolver?: IdentityResolver;
      logger: pino.Logger;
      now?: () => Date;
    }
  ) {
    this.deps.scheduler.setHandler(async conversationKey => {
      await this.processBuffer(conversationKey);
    });
  }

  async handleReceive(webhook: SendblueReceiveWebhook): Promise<ReceiveWebhookResult> {
    const claimed = await this.deps.store.claimInboundHandle(webhook.messageHandle);
    if (!claimed) return { ok: true, duplicate: true };

    if (isGroupWebhook(webhook)) {
      this.deps.logger.info(
        {
          groupId: webhook.groupId,
          messageHandle: webhook.messageHandle,
          participantCount: Array.isArray(webhook.participants) ? webhook.participants.length : undefined
        },
        'received group message; v0.2 group routing is silent'
      );
      return { ok: true, group: true, accepted: false };
    }

    const lineNumber = webhook.sendblueNumber || webhook.toNumber || this.deps.config.sendblueFromNumber;
    const phoneNumber = webhook.fromNumber;
    const key = directConversationKey(lineNumber, phoneNumber);
    const channel = channelFromSendblue(webhook);
    const item = inboundItemFromWebhook(webhook, channel, this.nowIso());
    const current = await this.deps.store.getConversation(key);
    const identity = current?.identity ?? (await this.resolveIdentity(key, lineNumber, phoneNumber));
    const base = current ?? createIdleConversation({ key, lineNumber, phoneNumber, identity, now: this.nowMs() });
    const state = this.applyChannel(base, channel, webhook.wasDowngraded === true);

    switch (state.state) {
      case 'idle':
        state.state = 'buffering';
        state.inboundBuffer = [item];
        state.lateArrivals = [];
        state.outboundQueue = [];
        state.deliveredMessages = [];
        state.cancelledMessages = [];
        state.currentOutboundIndex = 0;
        state.currentOutboundHandle = undefined;
        state.reprocessCount = 0;
        break;
      case 'buffering':
        state.inboundBuffer.push(item);
        break;
      case 'processing':
        state.lateArrivals.push(item);
        await this.persist(state);
        return { ok: true, conversationKey: key, state: state.state, accepted: true };
      case 'sending':
        await this.interruptSending(state, item);
        return { ok: true, conversationKey: key, state: 'buffering', accepted: true };
    }

    await this.persist(state);
    await this.deps.scheduler.schedule(
      key,
      calculateBufferTimeout(state.inboundBuffer.length, this.deps.config)
    );
    return { ok: true, conversationKey: key, state: state.state, accepted: true };
  }

  async handleTyping(input: TypingWebhookInput): Promise<{ ok: true; conversationKey: string }> {
    const key = directConversationKey(input.fromNumber, input.number);
    const existing = await this.deps.store.getConversation(key);
    const typing: ConversationTypingState = {
      number: input.number,
      fromNumber: input.fromNumber,
      isTyping: input.isTyping,
      timestamp: input.timestamp,
      receivedAt: this.nowIso()
    };

    const state =
      existing ??
      createIdleConversation({
        key,
        lineNumber: input.fromNumber,
        phoneNumber: input.number,
        channel: 'imessage',
        typing,
        now: this.nowMs()
      });

    if (this.deps.config.inboundTypingStateEnabled) {
      state.typing = typing;
      state.lastActivity = this.nowMs();
      await this.deps.store.setConversation(state);
    }

    return { ok: true, conversationKey: key };
  }

  async handleStatus(update: SendblueStatusWebhook) {
    const record = this.deps.statusStore.apply(update);
    const mapping = await this.deps.store.getOutboundHandleMapping(update.messageHandle);
    if (!mapping) return { ok: true, record, queued: false };

    const state = await this.deps.store.getConversation(mapping.conversationKey);
    if (!state || state.state !== 'sending') return { ok: true, record, queued: false };

    const channel = channelFromStatus(update, state.channel);
    const nextState = this.applyChannel(state, channel, update.wasDowngraded === true);

    if (update.status === 'ERROR' || update.status === 'DECLINED') {
      await this.abortQueue(nextState, update.messageHandle);
      return { ok: true, record, queued: true };
    }

    if (update.status === this.successStatus(nextState)) {
      await this.advanceQueue(nextState, update.messageHandle);
      return { ok: true, record, queued: true };
    }

    await this.persist(nextState);
    return { ok: true, record, queued: true };
  }

  async processBuffer(conversationKey: string): Promise<number> {
    const state = await this.deps.store.getConversation(conversationKey);
    if (!state || state.state !== 'buffering' || state.inboundBuffer.length === 0) return 0;

    state.state = 'processing';
    await this.persist(state);

    if (this.shouldSendTypingIndicator(state)) {
      this.deps.sendblueClient
        .sendTypingIndicator({ toNumber: state.phoneNumber })
        .catch(error => this.deps.logger.debug({ err: error, conversationKey }, 'typing indicator failed'));
    }

    let response: ChatEndpointResponse;
    try {
      response = await this.deps.chatClient.complete(createBufferedChatRequest(state));
    } catch (error) {
      this.deps.logger.warn({ err: error, conversationKey }, 'chat endpoint failed');
      await this.transitionToIdle(state);
      return 0;
    }

    const latest = await this.deps.store.getConversation(conversationKey);
    if (!latest) return 0;

    if (latest.lateArrivals.length > 0 && latest.reprocessCount < this.deps.config.maxReprocessAttempts) {
      latest.state = 'buffering';
      latest.inboundBuffer = [...latest.inboundBuffer, ...latest.lateArrivals];
      latest.lateArrivals = [];
      latest.reprocessCount += 1;
      latest.lastActivity = this.nowMs();
      await this.persist(latest);
      await this.deps.scheduler.schedule(
        conversationKey,
        calculateBufferTimeout(latest.inboundBuffer.length, this.deps.config)
      );
      return 0;
    }

    const messages = responseMessages(response);
    if (messages.length === 0) {
      await this.transitionToIdle(latest);
      return 0;
    }

    latest.state = 'sending';
    latest.outboundQueue = messages.map((content, index) => ({ id: `${this.nowMs()}-${index}`, content }));
    latest.inboundBuffer = [];
    latest.lateArrivals = [];
    latest.currentOutboundIndex = 0;
    latest.currentOutboundHandle = undefined;
    latest.reprocessCount = 0;
    latest.lastActivity = this.nowMs();
    await this.persist(latest);
    await this.sendCurrentMessage(latest);
    return messages.length;
  }

  async close(): Promise<void> {
    for (const timeout of this.deliveryTimeouts.values()) clearTimeout(timeout);
    this.deliveryTimeouts.clear();
    await this.deps.scheduler.close();
    await this.deps.store.close?.();
  }

  private async sendCurrentMessage(state: ConversationRecord): Promise<void> {
    const item = state.outboundQueue[state.currentOutboundIndex];
    if (!item) {
      await this.transitionToIdle(state);
      return;
    }

    const result = await this.deps.sendblueClient.sendMessage({
      toNumber: state.phoneNumber,
      content: item.content,
      statusCallback: `${this.deps.config.publicBaseUrl}/webhook/status`
    });

    const sent: OutboundMessageItem = {
      ...item,
      messageHandle: result.messageHandle,
      sentAt: this.nowIso()
    };
    state.outboundQueue[state.currentOutboundIndex] = sent;
    state.currentOutboundHandle = result.messageHandle;
    state.lastActivity = this.nowMs();

    if (result.messageHandle) {
      await this.deps.store.mapOutboundHandle(result.messageHandle, {
        conversationKey: state.key,
        messageIndex: state.currentOutboundIndex
      });
      this.startDeliveryTimeout(state.key, result.messageHandle);
    }

    await this.persist(state);
  }

  private async advanceQueue(state: ConversationRecord, messageHandle: string): Promise<void> {
    this.clearDeliveryTimeout(messageHandle);
    await this.deps.store.deleteOutboundHandleMapping(messageHandle);

    const delivered = state.outboundQueue[state.currentOutboundIndex];
    if (delivered) state.deliveredMessages.push(delivered.content);

    state.currentOutboundIndex += 1;
    state.currentOutboundHandle = undefined;
    state.lastActivity = this.nowMs();
    await this.persist(state);
    await this.sendCurrentMessage(state);
  }

  private async abortQueue(state: ConversationRecord, messageHandle?: string): Promise<void> {
    if (messageHandle) {
      this.clearDeliveryTimeout(messageHandle);
      await this.deps.store.deleteOutboundHandleMapping(messageHandle);
    }
    await this.transitionToIdle(state);
  }

  private async interruptSending(state: ConversationRecord, item: InboundMessageItem): Promise<void> {
    if (state.currentOutboundHandle) {
      this.clearDeliveryTimeout(state.currentOutboundHandle);
      await this.deps.store.deleteOutboundHandleMapping(state.currentOutboundHandle);
    }

    const cancelled = state.outboundQueue
      .slice(state.currentOutboundIndex)
      .map(message => truncateCancelledMessage(message.content, this.deps.config.cancelledMessageMaxLength));

    state.state = 'buffering';
    state.inboundBuffer = [item];
    state.lateArrivals = [];
    state.cancelledMessages = cancelled;
    state.outboundQueue = [];
    state.currentOutboundIndex = 0;
    state.currentOutboundHandle = undefined;
    state.lastActivity = this.nowMs();

    await this.persist(state);
    await this.deps.scheduler.schedule(state.key, calculateBufferTimeout(1, this.deps.config));
  }

  private startDeliveryTimeout(conversationKey: string, messageHandle: string): void {
    this.clearDeliveryTimeout(messageHandle);
    const timeout = setTimeout(() => {
      this.deliveryTimeouts.delete(messageHandle);
      this.handleDeliveryTimeout(conversationKey, messageHandle).catch(error =>
        this.deps.logger.warn({ err: error, conversationKey, messageHandle }, 'delivery timeout handling failed')
      );
    }, this.deps.config.outboundDeliveryTimeoutMs);
    this.deliveryTimeouts.set(messageHandle, timeout);
  }

  private async handleDeliveryTimeout(conversationKey: string, messageHandle: string): Promise<void> {
    const state = await this.deps.store.getConversation(conversationKey);
    if (!state || state.currentOutboundHandle !== messageHandle) return;
    await this.advanceQueue(state, messageHandle);
  }

  private clearDeliveryTimeout(messageHandle: string): void {
    const timeout = this.deliveryTimeouts.get(messageHandle);
    if (timeout) clearTimeout(timeout);
    this.deliveryTimeouts.delete(messageHandle);
  }

  private successStatus(state: ConversationRecord): 'SENT' | 'DELIVERED' {
    return state.smsDowngraded || state.channel === 'sms' ? 'SENT' : 'DELIVERED';
  }

  private shouldSendTypingIndicator(state: ConversationRecord): boolean {
    return (
      this.deps.config.outboundTypingIndicatorsEnabled &&
      state.channel === 'imessage' &&
      !state.smsDowngraded &&
      state.type === 'direct'
    );
  }

  private async transitionToIdle(state: ConversationRecord): Promise<void> {
    state.state = 'idle';
    state.inboundBuffer = [];
    state.lateArrivals = [];
    state.outboundQueue = [];
    state.currentOutboundIndex = 0;
    state.currentOutboundHandle = undefined;
    state.reprocessCount = 0;
    state.lastActivity = this.nowMs();
    await this.persist(state);
  }

  private async resolveIdentity(
    conversationKey: string,
    lineNumber: string,
    phoneNumber: string
  ): Promise<ConversationRecord['identity']> {
    if (!this.deps.identityResolver) return null;
    try {
      return await this.deps.identityResolver.resolveByPhone({ conversationKey, lineNumber, phoneNumber });
    } catch (error) {
      this.deps.logger.warn({ err: error, conversationKey }, 'identity resolver failed open');
      return null;
    }
  }

  private applyChannel(
    state: ConversationRecord,
    channel: ConversationChannel,
    wasDowngraded: boolean
  ): ConversationRecord {
    if (channel !== 'unknown') state.channel = channel;
    if (wasDowngraded || channel === 'sms') state.smsDowngraded = true;
    if (channel === 'imessage') state.smsDowngraded = false;
    return state;
  }

  private async persist(state: ConversationRecord): Promise<void> {
    state.lastActivity = this.nowMs();
    await this.deps.store.setConversation(state);
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private nowIso(): string {
    return this.now().toISOString();
  }

  private nowMs(): number {
    return this.now().getTime();
  }
}

function isGroupWebhook(webhook: SendblueReceiveWebhook): boolean {
  return Boolean(webhook.groupId) || webhook.messageType === 'group';
}

function inboundItemFromWebhook(
  webhook: SendblueReceiveWebhook,
  channel: ConversationChannel,
  receivedAt: string
): InboundMessageItem {
  return {
    content: webhook.content,
    fromNumber: webhook.fromNumber,
    toNumber: webhook.toNumber,
    messageHandle: webhook.messageHandle,
    channel,
    wasDowngraded: webhook.wasDowngraded === true,
    service: webhook.service,
    mediaUrl: webhook.mediaUrl,
    messageType: webhook.messageType,
    sendStyle: webhook.sendStyle,
    raw: webhook.raw,
    receivedAt
  };
}

function responseMessages(response: ChatEndpointResponse): string[] {
  if ('silence' in response && response.silence === true) return [];
  return response.messages.filter(message => message.trim() !== '');
}

function channelFromStatus(
  update: SendblueStatusWebhook,
  fallback: ConversationChannel
): ConversationChannel {
  if (update.wasDowngraded === true) return 'sms';
  if (update.service === 'SMS') return 'sms';
  if (update.service === 'RCS') return 'rcs';
  if (update.service === 'iMessage') return 'imessage';
  return fallback;
}
