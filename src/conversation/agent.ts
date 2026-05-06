import type pino from 'pino';
import type { ChatClient } from '../chat/client.js';
import { normalizeChatResponse } from '../chat/contract.js';
import type { ChatAction, ChatEndpointResponse, TargetRef } from '../chat/types.js';
import { resolveTargetRef } from '../chat/target-resolver.js';
import type { AgentConfig } from '../config/env.js';
import type { IdentityResolver } from '../identity/resolver.js';
import type { SendblueClient } from '../sendblue/client.js';
import type {
  SendblueActionResult,
  SendblueMarkReadRequest,
  SendblueOutboundGroupMessage,
  SendblueOutboundMessage,
  SendblueReactionRequest,
  SendblueReceiveWebhook,
  SendblueStatusWebhook
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
  groupConversationKey,
  type ConversationChannel,
  type ConversationRecord,
  type ConversationTypingState,
  type InboundMessageItem,
  type OutboundMessageItem
} from './types.js';

export type ReceiveWebhookResult =
  | { ok: true; duplicate: true }
  | { ok: true; group: true; conversationKey: string; accepted: false }
  | { ok: true; conversationKey: string; state: ConversationRecord['state']; accepted: true };

export type TypingWebhookInput = {
  number: string;
  fromNumber: string;
  isTyping: boolean;
  timestamp?: string;
};

type RichSendblueClient = SendblueClient & {
  sendGroupMessage?(
    message: SendblueOutboundGroupMessage
  ): Promise<SendblueActionResult | { messageHandle?: string; raw: unknown }>;
  sendReaction?(reaction: SendblueReactionRequest): Promise<SendblueActionResult>;
  markRead?(request: SendblueMarkReadRequest): Promise<SendblueActionResult>;
};

type TypingRefresh = {
  interval?: NodeJS.Timeout;
  max?: NodeJS.Timeout;
};

export class ConversationAgent {
  private readonly deliveryTimeouts = new Map<string, NodeJS.Timeout>();
  private readonly typingRefreshes = new Map<string, TypingRefresh>();

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

    const lineNumber = webhook.sendblueNumber || webhook.toNumber || this.deps.config.sendblueFromNumber;
    const phoneNumber = webhook.fromNumber;
    const groupId = webhook.groupId || undefined;
    const key = groupId ? groupConversationKey(lineNumber, groupId) : directConversationKey(lineNumber, phoneNumber);
    const channel = channelFromSendblue(webhook);
    const item = inboundItemFromWebhook(webhook, channel, this.nowIso());
    const current = withConversationDefaults(await this.deps.store.getConversation(key));

    if (groupId) {
      const invoked = await this.isInvokedGroupWebhook(webhook, key, current);
      const groupState = this.applyChannel(
        this.applyGroupMetadata(
          current ??
            createIdleConversation({
              key,
              type: 'group',
              lineNumber,
              phoneNumber,
              groupId,
              groupDisplayName: webhook.groupDisplayName,
              participants: webhook.participants,
              channel,
              now: this.nowMs()
            }),
          webhook
        ),
        channel,
        webhook.wasDowngraded === true
      );

      if (!invoked) {
        groupState.lastActivity = this.nowMs();
        await this.persist(groupState);
        this.deps.logger.info(
          {
            conversationKey: key,
            groupId,
            groupDisplayName: webhook.groupDisplayName,
            messageHandle: webhook.messageHandle,
            fromNumber: webhook.fromNumber,
            participantCount: Array.isArray(webhook.participants) ? webhook.participants.length : undefined
          },
          'received non-invoked group message; staying silent'
        );
        return { ok: true, group: true, conversationKey: key, accepted: false };
      }
    }

    const identity = current?.identity ?? (await this.resolveIdentity(key, lineNumber, phoneNumber));
    if (this.deps.config.validUserRequired && (!identity || identity.authorized === false)) {
      const state =
        current ??
        createIdleConversation({
          key,
          type: groupId ? 'group' : 'direct',
          lineNumber,
          phoneNumber,
          groupId,
          groupDisplayName: webhook.groupDisplayName,
          participants: webhook.participants,
          identity,
          channel,
          now: this.nowMs()
        });
      await this.persist(groupId ? this.applyGroupMetadata(state, webhook) : state);
      this.deps.logger.info(
        { conversationKey: key, fromNumber: phoneNumber, groupId, messageHandle: webhook.messageHandle },
        'received message from unauthorized identity; staying silent'
      );
      return groupId
        ? { ok: true, group: true, conversationKey: key, accepted: false }
        : { ok: true, conversationKey: key, state: state.state, accepted: true };
    }

    const base =
      current ??
      createIdleConversation({
        key,
        type: groupId ? 'group' : 'direct',
        lineNumber,
        phoneNumber,
        groupId,
        groupDisplayName: webhook.groupDisplayName,
        participants: webhook.participants,
        identity,
        now: this.nowMs()
      });
    const state = this.applyChannel(base, channel, webhook.wasDowngraded === true);
    if (groupId) this.applyGroupMetadata(state, webhook);
    state.identity = identity;

    switch (state.state) {
      case 'idle':
        state.state = 'buffering';
        state.inboundBuffer = [item];
        state.lateArrivals = [];
        state.lastInboundMessageHandles = [item.messageHandle];
        state.outboundQueue = [];
        state.deliveredMessages = [];
        state.cancelledMessages = [];
        state.currentOutboundIndex = 0;
        state.currentOutboundHandle = undefined;
        state.reprocessCount = 0;
        break;
      case 'buffering':
        state.inboundBuffer.push(item);
        state.lastInboundMessageHandles.push(item.messageHandle);
        break;
      case 'processing':
        state.lateArrivals.push(item);
        state.lastInboundMessageHandles.push(item.messageHandle);
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
    const existing = withConversationDefaults(await this.deps.store.getConversation(key));
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

    const state = withConversationDefaults(await this.deps.store.getConversation(mapping.conversationKey));
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
    const state = withConversationDefaults(await this.deps.store.getConversation(conversationKey));
    if (!state || state.state !== 'buffering' || state.inboundBuffer.length === 0) return 0;

    state.state = 'processing';
    await this.persist(state);

    await this.maybeSendReadReceipt(state);
    this.startTypingRefresh(state);

    let response: ChatEndpointResponse;
    try {
      response = await this.deps.chatClient.complete(createBufferedChatRequest(state));
    } catch (error) {
      this.deps.logger.warn({ err: error, conversationKey }, 'chat endpoint failed');
      this.stopTypingRefresh(conversationKey);
      await this.transitionToIdle(state);
      return 0;
    }

    const latest = withConversationDefaults(await this.deps.store.getConversation(conversationKey));
    if (!latest) return 0;

    if (latest.lateArrivals.length > 0 && latest.reprocessCount < this.deps.config.maxReprocessAttempts) {
      this.stopTypingRefresh(conversationKey);
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

    const actions = responseActions(response, this.deps.config);
    if (actions.length === 0) {
      this.stopTypingRefresh(conversationKey);
      await this.transitionToIdle(latest);
      return 0;
    }

    latest.state = 'sending';
    latest.lastInboundMessageHandles = latest.inboundBuffer.map(message => message.messageHandle);
    latest.outboundQueue = actions.map((action, index) => ({
      id: `${this.nowMs()}-${index}`,
      ...resolveQueuedActionTargets(action, latest.lastInboundMessageHandles)
    }));
    latest.inboundBuffer = [];
    latest.lateArrivals = [];
    latest.currentOutboundIndex = 0;
    latest.currentOutboundHandle = undefined;
    latest.reprocessCount = 0;
    latest.lastActivity = this.nowMs();
    await this.persist(latest);
    await this.sendCurrentMessage(latest);
    return actions.length;
  }

  async close(): Promise<void> {
    for (const timeout of this.deliveryTimeouts.values()) clearTimeout(timeout);
    this.deliveryTimeouts.clear();
    for (const conversationKey of this.typingRefreshes.keys()) this.stopTypingRefresh(conversationKey);
    await this.deps.scheduler.close();
    await this.deps.store.close?.();
  }

  private async sendCurrentMessage(state: ConversationRecord): Promise<void> {
    const item = state.outboundQueue[state.currentOutboundIndex];
    if (!item) {
      await this.transitionToIdle(state);
      return;
    }

    if (item.kind === 'silence') {
      await this.skipCurrentAction(state, item, 'silence action does not send to Sendblue');
      return;
    }

    let result: SendblueActionResult | { messageHandle?: string; raw?: unknown } | undefined;
    try {
      result = await this.sendOutboundAction(state, item);
    } catch (error) {
      this.deps.logger.warn(
        { err: error, conversationKey: state.key, actionKind: item.kind },
        'outbound action failed; skipping'
      );
      await this.skipCurrentAction(state, item, 'sendblue action failed');
      return;
    }
    if (!result) return;

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

    if (!result.messageHandle) {
      await this.advanceQueue(state, '');
    }
  }

  private async advanceQueue(state: ConversationRecord, messageHandle: string): Promise<void> {
    if (messageHandle) this.clearDeliveryTimeout(messageHandle);

    const delivered = state.outboundQueue[state.currentOutboundIndex];
    if (delivered?.content) state.deliveredMessages.push(delivered.content);

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
    this.stopTypingRefresh(state.key);
    await this.transitionToIdle(state);
  }

  private async interruptSending(state: ConversationRecord, item: InboundMessageItem): Promise<void> {
    if (state.currentOutboundHandle) {
      this.clearDeliveryTimeout(state.currentOutboundHandle);
      await this.deps.store.deleteOutboundHandleMapping(state.currentOutboundHandle);
    }

    const cancelled = state.outboundQueue
      .slice(state.currentOutboundIndex)
      .map(message =>
        truncateCancelledMessage(actionSummary(message), this.deps.config.cancelledMessageMaxLength)
      );

    state.state = 'buffering';
    state.inboundBuffer = [item];
    state.lateArrivals = [];
    state.lastInboundMessageHandles = [item.messageHandle];
    state.cancelledMessages = cancelled;
    state.outboundQueue = [];
    state.currentOutboundIndex = 0;
    state.currentOutboundHandle = undefined;
    state.lastActivity = this.nowMs();
    this.stopTypingRefresh(state.key);

    await this.persist(state);
    await this.deps.scheduler.schedule(state.key, calculateBufferTimeout(1, this.deps.config));
  }

  private async sendOutboundAction(
    state: ConversationRecord,
    item: OutboundMessageItem
  ): Promise<{ messageHandle?: string; raw?: unknown } | undefined> {
    if (item.kind === 'reaction') {
      return this.sendReactionAction(state, item);
    }

    if ((item.kind === 'message' || item.kind === 'reply') && !item.content?.trim() && !item.mediaUrl) {
      await this.skipCurrentAction(state, item, 'message action requires content');
      return undefined;
    }

    if (item.kind === 'media' && !item.mediaUrl) {
      await this.skipCurrentAction(state, item, 'media action requires mediaUrl');
      return undefined;
    }

    if (item.kind === 'reply' && item.replyTo) {
      this.deps.logger.info(
        { conversationKey: state.key, actionId: item.id, replyTo: item.replyTo },
        'sending contextual reply as normal Sendblue message'
      );
    }

    const statusCallback = `${this.deps.config.publicBaseUrl}/webhook/status`;
    if (state.type === 'group') {
      const client = this.deps.sendblueClient as RichSendblueClient;
      if (!client.sendGroupMessage || !state.groupId) {
        await this.skipCurrentAction(state, item, 'group send is not supported by the configured Sendblue client');
        return undefined;
      }

      const groupMessage: SendblueOutboundGroupMessage = {
        groupId: state.groupId,
        content: item.content ?? '',
        statusCallback
      };
      if (item.mediaUrl) groupMessage.mediaUrl = item.mediaUrl;
      if (item.sendStyle) groupMessage.sendStyle = item.sendStyle;
      return client.sendGroupMessage(groupMessage);
    }

    const message: SendblueOutboundMessage = {
      toNumber: state.phoneNumber,
      content: item.content ?? '',
      statusCallback
    };
    if (item.mediaUrl) message.mediaUrl = item.mediaUrl;
    if (item.sendStyle) message.sendStyle = item.sendStyle;
    return this.deps.sendblueClient.sendMessage(message);
  }

  private async sendReactionAction(
    state: ConversationRecord,
    item: OutboundMessageItem
  ): Promise<{ messageHandle?: string; raw?: unknown } | undefined> {
    const client = this.deps.sendblueClient as RichSendblueClient;
    if (!client.sendReaction) {
      await this.skipCurrentAction(state, item, 'reaction send is not supported by the configured Sendblue client');
      return undefined;
    }

    const messageHandle = this.resolveInboundTarget(item, state);
    if (!messageHandle) {
      await this.skipCurrentAction(state, item, 'reaction target did not resolve to an inbound messageHandle');
      return undefined;
    }

    return client.sendReaction({
      messageHandle,
      reaction: item.reaction as SendblueReactionRequest['reaction'],
      partIndex: item.partIndex
    });
  }

  private resolveInboundTarget(item: OutboundMessageItem, state: ConversationRecord): string | undefined {
    const requested = item.targetMessageHandle ?? item.replyTo;
    if (requested && state.lastInboundMessageHandles.includes(requested)) return requested;
    if (requested?.startsWith('alias:')) {
      const alias = requested.slice('alias:'.length).trim() as 'latest' | 'previous' | 'first' | 'last';
      const result = resolveTargetRef(state.inboundBuffer, { alias, partIndex: item.partIndex });
      return result.ok ? result.target.messageHandle : undefined;
    }
    if (requested?.startsWith('content:')) {
      const [, contentIncludes = '', occurrenceRaw = ''] = requested.split(':');
      const occurrence = occurrenceRaw === 'first' || occurrenceRaw === 'last' ? occurrenceRaw : undefined;
      const result = resolveTargetRef(state.inboundBuffer, {
        contentIncludes,
        occurrence,
        partIndex: item.partIndex
      });
      return result.ok ? result.target.messageHandle : undefined;
    }
    if (requested?.startsWith('handle:')) {
      const handle = requested.slice('handle:'.length).trim();
      if (state.lastInboundMessageHandles.includes(handle)) return handle;
    }
    return state.lastInboundMessageHandles.at(-1);
  }

  private async skipCurrentAction(
    state: ConversationRecord,
    item: OutboundMessageItem,
    reason: string
  ): Promise<void> {
    state.outboundQueue[state.currentOutboundIndex] = {
      ...item,
      skippedAt: this.nowIso(),
      skipReason: reason
    };
    this.deps.logger.warn(
      {
        conversationKey: state.key,
        actionId: item.id,
        actionKind: item.kind,
        reason
      },
      'skipping unsupported rich action'
    );
    state.currentOutboundIndex += 1;
    state.currentOutboundHandle = undefined;
    await this.persist(state);
    await this.sendCurrentMessage(state);
  }

  private async maybeSendReadReceipt(state: ConversationRecord): Promise<void> {
    if (!this.shouldSendReadReceipt(state)) return;
    const client = this.deps.sendblueClient as RichSendblueClient;
    if (!client.markRead) {
      this.deps.logger.debug({ conversationKey: state.key }, 'read receipt is not supported by Sendblue client');
      return;
    }

    if (this.deps.config.readReceiptDebounceMs > 0) {
      await new Promise(resolve => setTimeout(resolve, this.deps.config.readReceiptDebounceMs));
    }

    try {
      await client.markRead({ toNumber: state.phoneNumber });
    } catch (error) {
      this.deps.logger.debug({ err: error, conversationKey: state.key }, 'read receipt failed');
    }
  }

  private shouldSendReadReceipt(state: ConversationRecord): boolean {
    return (
      this.deps.config.readReceiptsEnabled &&
      state.type === 'direct' &&
      !state.smsDowngraded &&
      (state.channel === 'imessage' || state.channel === 'rcs')
    );
  }

  private startTypingRefresh(state: ConversationRecord): void {
    if (!this.shouldSendTypingIndicator(state)) return;

    this.stopTypingRefresh(state.key);
    const send = () => {
      this.deps.sendblueClient
        .sendTypingIndicator({ toNumber: state.phoneNumber })
        .catch(error => this.deps.logger.debug({ err: error, conversationKey: state.key }, 'typing indicator failed'));
    };

    send();

    const refresh: TypingRefresh = {};
    if (this.deps.config.typingRefreshIntervalMs > 0) {
      refresh.interval = setInterval(send, this.deps.config.typingRefreshIntervalMs);
    }
    if (this.deps.config.typingRefreshMaxMs > 0) {
      refresh.max = setTimeout(() => this.stopTypingRefresh(state.key), this.deps.config.typingRefreshMaxMs);
    }
    this.typingRefreshes.set(state.key, refresh);
  }

  private stopTypingRefresh(conversationKey: string): void {
    const refresh = this.typingRefreshes.get(conversationKey);
    if (!refresh) return;
    if (refresh.interval) clearInterval(refresh.interval);
    if (refresh.max) clearTimeout(refresh.max);
    this.typingRefreshes.delete(conversationKey);
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
    const state = withConversationDefaults(await this.deps.store.getConversation(conversationKey));
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
    this.stopTypingRefresh(state.key);
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

  private async isInvokedGroupWebhook(
    webhook: SendblueReceiveWebhook,
    conversationKey: string,
    current?: ConversationRecord
  ): Promise<boolean> {
    if (mentionsAgent(webhook.content, this.deps.config.agentDisplayName)) return true;

    for (const handle of referencedMessageHandles(webhook.raw)) {
      const mapping = await this.deps.store.getOutboundHandleMapping(handle);
      if (mapping?.conversationKey === conversationKey) return true;
    }

    if (!current) return false;
    return current.deliveredMessages.some(message => message.trim() !== '' && webhook.content.includes(message));
  }

  private applyGroupMetadata(state: ConversationRecord, webhook: SendblueReceiveWebhook): ConversationRecord {
    state.type = 'group';
    state.groupId = webhook.groupId ?? state.groupId;
    state.groupDisplayName = webhook.groupDisplayName ?? state.groupDisplayName;
    state.participants = webhook.participants ?? state.participants;
    return state;
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

function responseActions(
  response: ChatEndpointResponse,
  config: Pick<AgentConfig, 'chatResponseTags' | 'chatResponseParseTags'>
): Array<Omit<OutboundMessageItem, 'id'>> {
  const normalized = normalizeChatResponse(response, {
    tags: config.chatResponseTags,
    parseTags: config.chatResponseParseTags
  });
  if (normalized.silence === true) return [];
  return normalized.actions.map(actionFromChatAction);
}

function actionFromChatAction(action: ChatAction): Omit<OutboundMessageItem, 'id'> {
  switch (action.type) {
    case 'message':
      return {
        kind: action.mediaUrl ? 'media' : 'message',
        content: action.content,
        mediaUrl: action.mediaUrl,
        sendStyle: action.sendStyle
      };
    case 'media':
      return {
        kind: 'media',
        content: action.content,
        mediaUrl: action.mediaUrl,
        sendStyle: action.sendStyle
      };
    case 'reply':
      return {
        kind: 'reply',
        content: action.content,
        mediaUrl: action.mediaUrl,
        sendStyle: action.sendStyle,
        replyTo: targetHandle(action.target),
        partIndex: targetPartIndex(action.target)
      };
    case 'reaction':
      return {
        kind: 'reaction',
        reaction: action.reaction,
        targetMessageHandle: targetHandle(action.target),
        partIndex: targetPartIndex(action.target)
      };
    case 'silence':
      return { kind: 'silence' };
  }
}

function resolveQueuedActionTargets(
  action: Omit<OutboundMessageItem, 'id'>,
  inboundHandles: string[]
): Omit<OutboundMessageItem, 'id'> {
  if (action.kind !== 'reaction') return action;
  const requested = action.targetMessageHandle;
  if (requested && inboundHandles.includes(requested)) return action;
  return {
    ...action,
    targetMessageHandle: inboundHandles.at(-1) ?? requested
  };
}

function targetHandle(target: TargetRef | undefined): string | undefined {
  if (!target) return undefined;
  if ('messageHandle' in target) return target.messageHandle;
  if ('alias' in target) return `alias:${target.alias}`;
  if ('contentIncludes' in target) return `content:${target.contentIncludes}:${target.occurrence ?? ''}`;
  if ('content' in target) return `content:${target.content}:`;
  return `part:${target.partIndex}`;
}

function targetPartIndex(target: TargetRef | undefined): number | undefined {
  return target?.partIndex;
}

function withConversationDefaults(record: ConversationRecord | undefined): ConversationRecord | undefined {
  if (!record) return undefined;
  record.lastInboundMessageHandles ??= [];
  return record;
}

function mentionsAgent(content: string, displayName: string | undefined): boolean {
  if (!displayName?.trim()) return false;
  const escaped = displayName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\s)@?${escaped}(\\b|\\s|[:,.!?])`, 'i').test(content);
}

function referencedMessageHandles(raw: Record<string, unknown>): string[] {
  const handles = new Set<string>();
  const visit = (value: unknown, key = '') => {
    if (typeof value === 'string') {
      const normalizedKey = key.toLowerCase();
      if (
        normalizedKey.includes('message_handle') ||
        normalizedKey.includes('messagehandle') ||
        normalizedKey.includes('reply_to') ||
        normalizedKey.includes('reacted_to') ||
        normalizedKey.includes('target')
      ) {
        handles.add(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(item => visit(item, key));
      return;
    }
    if (typeof value === 'object' && value !== null) {
      for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
        visit(childValue, childKey);
      }
    }
  };
  visit(raw);
  return [...handles];
}

function actionSummary(message: OutboundMessageItem): string {
  if (message.content) return message.content;
  if (message.mediaUrl) return `media:${message.mediaUrl}`;
  if (message.reaction) return `reaction:${message.reaction}`;
  return message.kind;
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
