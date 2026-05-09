import type pino from 'pino';
import type { ChatClient } from '../chat/client.js';
import { normalizeChatResponse } from '../chat/contract.js';
import type { ChatAction, ChatEndpointResponse, TargetRef } from '../chat/types.js';
import { resolveTargetRef } from '../chat/target-resolver.js';
import type { AgentConfig } from '../config/env.js';
import type { IdentityResolver } from '../identity/resolver.js';
import type { LimitTracker } from '../limits/tracker.js';
import type { SmsLimitStallScheduler } from '../limits/retry.js';
import type { AgentMetrics } from '../metrics/registry.js';
import { normalizeErrorCodeLabel } from '../metrics/registry.js';
import type { RequestContext } from '../http/trace.js';
import { SendblueApiError, type SendblueClient } from '../sendblue/client.js';
import { upsertContactFromIdentity } from '../sendblue/contacts.js';
import type {
  SendblueActionResult,
  SendblueContactRequest,
  SendblueContactResult,
  SendblueMarkReadRequest,
  SendblueOutboundGroupMessage,
  SendblueOutboundMessage,
  SendblueReactionRequest,
  SendblueReceiveWebhook,
  SendblueStatusWebhook
} from '../sendblue/types.js';
import { classifyErrorCode, type InMemoryStatusStore } from '../status/tracker.js';
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
  createContact?(contact: SendblueContactRequest): Promise<SendblueContactResult>;
};

type TypingRefresh = {
  start?: NodeJS.Timeout;
  interval?: NodeJS.Timeout;
  max?: NodeJS.Timeout;
};

export class ConversationAgent {
  private readonly deliveryTimeouts = new Map<string, NodeJS.Timeout>();
  private readonly typingRefreshes = new Map<string, TypingRefresh>();
  private readonly transientRetryTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly deps: {
      config: AgentConfig;
      chatClient: ChatClient;
      sendblueClient: SendblueClient;
      statusStore: InMemoryStatusStore;
      store: ConversationStore;
      scheduler: BufferScheduler;
      identityResolver?: IdentityResolver;
      limitTracker?: LimitTracker;
      smsLimitStallScheduler?: SmsLimitStallScheduler;
      metrics?: AgentMetrics;
      logger: pino.Logger;
      now?: () => Date;
    }
  ) {
    this.deps.scheduler.setHandler(async (conversationKey, options) => {
      await this.processBuffer(conversationKey, options?.traceId);
    });
  }

  async handleReceive(
    webhook: SendblueReceiveWebhook,
    ctx?: RequestContext
  ): Promise<ReceiveWebhookResult> {
    const logger = ctx?.logger ?? this.deps.logger;
    const claimed = await this.deps.store.claimInboundHandle(webhook.messageHandle);
    this.deps.metrics?.webhookDedupe.inc({ result: claimed ? 'miss' : 'hit' });
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
        logger.info(
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

    const identity = current?.identity ?? (await this.resolveIdentity(key, lineNumber, phoneNumber, logger));
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
      logger.info(
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
    const inboundAtIso = this.nowIso();
    state.lastInboundAt = inboundAtIso;

    // LimitTracker.recordInbound is best-effort — failures should not block
    // the agent. Track per-line distinct-inbound counters and last_inbound_at
    // for 24h-reply-window classification on outbound.
    if (this.deps.limitTracker) {
      try {
        await this.deps.limitTracker.recordInbound({
          lineNumber,
          phoneNumber,
          receivedAt: inboundAtIso
        });
      } catch (error) {
        logger.warn(
          { err: error, conversationKey: key, lineNumber, phoneNumber },
          'limit tracker recordInbound failed'
        );
      }
    }

    // Sendblue contact upsert is fire-and-forget — never block buffering or
    // chat dispatch on the contacts API. The helper itself swallows errors;
    // we still attach a defensive .catch in case the orchestration around it
    // throws (e.g. an iterator surprise).
    void this.upsertContactsForReceive(webhook, identity, lineNumber, phoneNumber, groupId).catch(error =>
      logger.warn(
        { err: error, conversationKey: key },
        'unhandled error in contact upsert orchestration'
      )
    );

    if (ctx?.traceId) state.traceId = ctx.traceId;

    logger.info(
      {
        conversationKey: key,
        messageHandle: webhook.messageHandle,
        fromNumber: phoneNumber,
        // What Sendblue sent us:
        sendblueService: webhook.service,
        sendblueWasDowngraded: webhook.wasDowngraded,
        // What the agent decided:
        channel: state.channel,
        smsDowngraded: state.smsDowngraded
      },
      'received inbound message'
    );

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
      calculateBufferTimeout(state.inboundBuffer.length, this.deps.config),
      state.traceId ? { traceId: state.traceId } : undefined
    );
    return { ok: true, conversationKey: key, state: state.state, accepted: true };
  }

  async handleTyping(
    input: TypingWebhookInput,
    _ctx?: RequestContext
  ): Promise<{ ok: true; conversationKey: string }> {
    const forwardKey = directConversationKey(input.fromNumber, input.number);
    const reverseKey = directConversationKey(input.number, input.fromNumber);
    const configuredLineNumber = this.deps.config.sendblueFromNumber;
    const configuredKey =
      input.fromNumber === configuredLineNumber
        ? forwardKey
        : input.number === configuredLineNumber
          ? reverseKey
          : undefined;
    const existingForward = withConversationDefaults(await this.deps.store.getConversation(forwardKey));
    const existingReverse = withConversationDefaults(await this.deps.store.getConversation(reverseKey));
    const key = existingForward ? forwardKey : existingReverse ? reverseKey : configuredKey ?? forwardKey;
    const existing = existingForward ?? existingReverse;
    const lineNumber = key === reverseKey ? input.number : input.fromNumber;
    const phoneNumber = key === reverseKey ? input.fromNumber : input.number;
    const typing: ConversationTypingState = {
      number: phoneNumber,
      fromNumber: lineNumber,
      isTyping: input.isTyping,
      timestamp: input.timestamp,
      receivedAt: this.nowIso()
    };

    const state =
      existing ??
      createIdleConversation({
        key,
        lineNumber,
        phoneNumber,
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

  async handleStatus(update: SendblueStatusWebhook, ctx?: RequestContext) {
    const record = this.deps.statusStore.apply(update);
    const mapping = await this.deps.store.getOutboundHandleMapping(update.messageHandle);
    if (!mapping) return { ok: true, record, queued: false };

    const state = withConversationDefaults(await this.deps.store.getConversation(mapping.conversationKey));
    if (!state || state.state !== 'sending') return { ok: true, record, queued: false };

    const channel = channelFromStatus(update, state.channel);
    const nextState = this.applyChannel(state, channel, update.wasDowngraded === true);
    // Recover the conversation traceId (set on inbound) and chain it with the
    // current request's transport traceId so logs correlate both directions.
    const baseLogger = ctx?.logger ?? this.deps.logger;
    const conversationTraceId = state.traceId;
    const logger = conversationTraceId ? baseLogger.child({ conversationTraceId }) : baseLogger;

    // Surface every callback for the active sending queue at info. Lets
    // operators see when DELIVERED/SENT actually arrive vs. when the agent
    // sent the message — useful when ordered-delivery gaps look anomalous.
    logger.info(
      {
        conversationKey: mapping.conversationKey,
        messageHandle: update.messageHandle,
        status: update.status,
        channel: nextState.channel,
        smsDowngraded: nextState.smsDowngraded,
        errorCode: update.errorCode
      },
      'status callback received'
    );

    if (this.deps.metrics) {
      const errorCategory = update.errorCode
        ? classifyErrorCode(update.errorCode)
        : 'none';
      this.deps.metrics.statusCallbackTotal.inc({
        status: update.status,
        channel: nextState.channel,
        error_category: errorCategory
      });
      const isTerminal =
        update.status === 'ERROR' ||
        update.status === 'DECLINED' ||
        update.status === this.successStatus(nextState);
      if (isTerminal) {
        const sent = nextState.outboundQueue[mapping.messageIndex];
        const sentAtIso = sent?.sentAt;
        if (sentAtIso) {
          const sentMs = Date.parse(sentAtIso);
          if (Number.isFinite(sentMs)) {
            const elapsed = Math.max(0, (this.nowMs() - sentMs) / 1000);
            this.deps.metrics.statusToTerminalDuration.observe(
              { terminal: update.status, channel: nextState.channel },
              elapsed
            );
          }
        }
      }
    }

    if (update.status === 'ERROR' || update.status === 'DECLINED') {
      const retried = await this.maybeRetryFromStatus(nextState, update);
      if (retried) {
        return { ok: true, record, queued: true };
      }
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

  async processBuffer(conversationKey: string, traceId?: string): Promise<number> {
    const state = withConversationDefaults(await this.deps.store.getConversation(conversationKey));
    if (!state || state.state !== 'buffering' || state.inboundBuffer.length === 0) return 0;

    const effectiveTraceId = traceId ?? state.traceId;
    const logger = effectiveTraceId
      ? this.deps.logger.child({ traceId: effectiveTraceId })
      : this.deps.logger;

    state.state = 'processing';
    await this.persist(state);

    await this.maybeSendReadReceipt(state);
    this.startTypingRefresh(state);

    const chatStartedAt = process.hrtime.bigint();
    let response: ChatEndpointResponse;
    try {
      response = await this.deps.chatClient.complete(createBufferedChatRequest(state));
      this.deps.metrics?.chatDispatchDuration.observe(
        { result: 'success' },
        elapsedSeconds(chatStartedAt)
      );
    } catch (error) {
      this.deps.metrics?.chatDispatchDuration.observe(
        { result: 'error' },
        elapsedSeconds(chatStartedAt)
      );
      logger.warn({ err: error, conversationKey }, 'chat endpoint failed');
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
        calculateBufferTimeout(latest.inboundBuffer.length, this.deps.config),
        latest.traceId ? { traceId: latest.traceId } : undefined
      );
      return 0;
    }

    const actions = responseActions(response, this.deps.config);
    if (actions.length === 0) {
      this.stopTypingRefresh(conversationKey);
      await this.transitionToIdle(latest);
      return 0;
    }

    // Typing exists to bridge the gap before the first outbound message lands.
    // Once we have a response and are about to send it, refreshing typing only
    // risks lighting up a phantom bubble (Sendblue's iMessage typing indicator
    // persists on the device for ~60s after the last call, even with no
    // refresh). Cancel any scheduled or in-flight typing here.
    this.stopTypingRefresh(conversationKey);

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
    for (const timeout of this.transientRetryTimers.values()) clearTimeout(timeout);
    this.transientRetryTimers.clear();
    this.deps.smsLimitStallScheduler?.cancelAll();
    for (const conversationKey of this.typingRefreshes.keys()) this.stopTypingRefresh(conversationKey);
    await this.deps.scheduler.close();
    await this.deps.store.close?.();
  }

  /**
   * Re-arm transient-retry and SMS-limit-stall timers from persisted state.
   *
   * Both retry mechanisms use process-local `setTimeout`, so a fresh
   * process loses every in-flight retry on restart. This method enumerates
   * the persisted retry/stall state and re-schedules timers with the
   * appropriate remaining delay. Safe to call concurrently with normal
   * webhook traffic — the retry-id check inside `runRetry` drops any
   * recovered retry whose target item has already advanced.
   *
   * Returns counts for telemetry. The in-memory store path returns
   * `{0, 0}` (state is per-process and gone). Failures during recovery
   * log at `warn` and do not throw — recovery is best-effort and must
   * never gate startup.
   */
  async recoverPendingRetries(): Promise<{
    smsStallsResumed: number;
    transientRetriesResumed: number;
  }> {
    let smsStallsResumed = 0;
    let transientRetriesResumed = 0;

    if (this.deps.limitTracker && this.deps.smsLimitStallScheduler) {
      try {
        const stalls = await this.deps.limitTracker.listSmsLimitStalls();
        const nowMs = this.nowMs();
        for (const stall of stalls) {
          const state = withConversationDefaults(
            await this.deps.store.getConversation(stall.conversationKey)
          );
          if (!state || state.state !== 'sending') {
            // Stall is stranded — the conversation it pointed at is no
            // longer in 'sending'. Clear it so /admin/limits stops
            // reporting a phantom stall.
            try {
              await this.deps.limitTracker.clearSmsLimitStall(stall.lineNumber);
            } catch (error) {
              this.deps.logger.warn(
                { err: error, lineNumber: stall.lineNumber },
                'failed to clear stranded sms-limit stall during recovery'
              );
            }
            continue;
          }
          const item = state.outboundQueue[state.currentOutboundIndex];
          if (!item) continue;
          const remainingMs = Math.max(0, stall.nextRetryAt.getTime() - nowMs);
          const conversationKey = stall.conversationKey;
          const lineNumber = stall.lineNumber;
          const traceId = state.traceId;
          const expected = { itemId: item.id, retryCount: item.retryCount ?? 0 };
          this.deps.smsLimitStallScheduler.schedule(
            stall.lineNumber,
            () =>
              this.runRetry(conversationKey, expected, traceId).catch(error =>
                this.traceLogger(traceId).warn(
                  { err: error, conversationKey, lineNumber },
                  'recovered sms-limit stall retry execution failed'
                )
              ),
            remainingMs
          );
          smsStallsResumed += 1;
          this.deps.logger.info(
            {
              conversationKey,
              lineNumber,
              attempts: stall.attempts,
              remainingMs,
              nextRetryAt: stall.nextRetryAt.toISOString()
            },
            'resumed sms-limit stall from persisted state'
          );
        }
      } catch (error) {
        this.deps.logger.warn(
          { err: error },
          'sms-limit stall recovery failed; continuing without resumed stalls'
        );
      }
    }

    try {
      const nowMs = this.nowMs();
      for await (const conversationKey of this.deps.store.listConversationKeys()) {
        let state: ConversationRecord | undefined;
        try {
          state = withConversationDefaults(await this.deps.store.getConversation(conversationKey));
        } catch (error) {
          this.deps.logger.warn(
            { err: error, conversationKey },
            'failed to load conversation during retry recovery'
          );
          continue;
        }
        if (!state || state.state !== 'sending') continue;
        const item = state.outboundQueue[state.currentOutboundIndex];
        if (!item || !item.nextRetryAt || (item.retryCount ?? 0) <= 0) continue;
        const target = new Date(item.nextRetryAt).getTime();
        if (Number.isNaN(target)) continue;
        const remainingMs = Math.max(0, target - nowMs);
        const expected = { itemId: item.id, retryCount: item.retryCount ?? 0 };
        const traceId = state.traceId;
        this.clearTransientRetry(conversationKey);
        const action = outboundOperationLabel(item.kind, state.type);
        const timer = setTimeout(() => {
          this.transientRetryTimers.delete(conversationKey);
          this.deps.metrics?.transientRetryTotal.inc({ action, outcome: 'executed' });
          this.runRetry(conversationKey, expected, traceId).catch(error =>
            this.traceLogger(traceId).warn(
              { err: error, conversationKey },
              'recovered transient retry execution failed'
            )
          );
        }, remainingMs);
        this.transientRetryTimers.set(conversationKey, timer);
        transientRetriesResumed += 1;
        this.deps.logger.info(
          {
            conversationKey,
            actionKind: item.kind,
            retryCount: item.retryCount,
            remainingMs,
            nextRetryAt: item.nextRetryAt
          },
          'resumed transient retry from persisted state'
        );
      }
    } catch (error) {
      this.deps.logger.warn(
        { err: error },
        'transient retry recovery failed; continuing without resumed retries'
      );
    }

    return { smsStallsResumed, transientRetriesResumed };
  }

  private async sendCurrentMessage(state: ConversationRecord): Promise<void> {
    const logger = this.traceLogger(state.traceId);
    const item = state.outboundQueue[state.currentOutboundIndex];
    if (!item) {
      await this.transitionToIdle(state);
      return;
    }

    if (item.kind === 'silence') {
      await this.skipCurrentAction(state, item, 'silence action does not send to Sendblue');
      return;
    }

    // One-shot typing between queued outbound messages so the user sees a
    // brief typing bubble bridging consecutive bubbles. We never refresh
    // here — Sendblue's iMessage typing indicator is replaced as soon as the
    // next message lands on the device, so a single call is enough.
    if (
      state.currentOutboundIndex > 0 &&
      isOutboundMessageKind(item.kind) &&
      this.shouldSendTypingIndicator(state)
    ) {
      this.deps.sendblueClient
        .sendTypingIndicator({ toNumber: state.phoneNumber })
        .catch(error =>
          logger.debug(
            { err: error, conversationKey: state.key },
            'inter-message typing failed'
          )
        );
    }

    // Pre-emptive 1/s pacing per Sendblue line. The tracker awaits any
    // required delay internally; on the first send and after long idle
    // gaps, this is a no-op. Pacing applies to all message kinds (message,
    // reply, media); reactions and typing skip this gate via their own
    // dispatch paths in `sendReactionAction` / `sendTypingIndicator`.
    if (this.deps.limitTracker && isOutboundMessageKind(item.kind)) {
      try {
        await this.deps.limitTracker.acquireSendSlot(state.lineNumber);
      } catch (error) {
        logger.warn(
          { err: error, conversationKey: state.key },
          'limit tracker acquireSendSlot failed; proceeding without pacing'
        );
      }
    }

    let result: SendblueActionResult | { messageHandle?: string; raw?: unknown } | undefined;
    const sendStartedAt = process.hrtime.bigint();
    const operation = outboundOperationLabel(item.kind, state.type);
    try {
      result = await this.sendOutboundAction(state, item);
      this.recordOutboundMetrics({
        operation,
        channel: state.channel,
        result: result === undefined ? 'suppressed' : 'success',
        errorCode: undefined,
        elapsedSec: elapsedSeconds(sendStartedAt)
      });
    } catch (error) {
      this.recordOutboundMetrics({
        operation,
        channel: state.channel,
        result: 'error',
        errorCode: errorCodeFromException(error),
        elapsedSec: elapsedSeconds(sendStartedAt)
      });
      const handled = await this.handleSendError(state, item, error);
      if (handled) return;
      logger.warn(
        { err: error, conversationKey: state.key, actionKind: item.kind },
        'outbound action failed; skipping'
      );
      await this.skipCurrentAction(state, item, 'sendblue action failed');
      return;
    }
    if (!result) return;

    // Record successful outbound for telemetry/pacing. Best-effort; do not
    // gate the queue on tracker availability or recording errors.
    if (this.deps.limitTracker && isOutboundMessageKind(item.kind) && state.type === 'direct') {
      void this.deps.limitTracker
        .recordOutbound({
          lineNumber: state.lineNumber,
          phoneNumber: state.phoneNumber,
          lastInboundAt: state.lastInboundAt
        })
        .catch(error =>
          logger.warn(
            { err: error, conversationKey: state.key },
            'limit tracker recordOutbound failed'
          )
        );
    }

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
        messageIndex: state.currentOutboundIndex,
        traceId: state.traceId
      });
      this.startDeliveryTimeout(state.key, result.messageHandle);
    }

    await this.persist(state);

    if (!result.messageHandle) {
      await this.advanceQueue(state, '');
    }
  }

  private async advanceQueue(state: ConversationRecord, messageHandle: string): Promise<void> {
    if (messageHandle) {
      this.clearDeliveryTimeout(messageHandle);
      // Outbound-handle → conversation-key mapping is no longer needed once
      // the queue has advanced past this handle; deleting eagerly avoids
      // stale Redis keys that otherwise live until CONVERSATION_TTL_SECONDS.
      await this.deps.store.deleteOutboundHandleMapping(messageHandle);
    }

    const delivered = state.outboundQueue[state.currentOutboundIndex];
    if (delivered?.content) state.deliveredMessages.push(delivered.content);

    state.currentOutboundIndex += 1;
    state.currentOutboundHandle = undefined;
    state.lastActivity = this.nowMs();
    // A successful advance means the previous send made it through. Any
    // SMS-limit stall metadata for this line is now stale; clear it so
    // /admin/limits stops reporting an active stall and a future stall
    // starts a fresh attempt counter.
    if (this.deps.limitTracker) {
      try {
        await this.deps.limitTracker.clearSmsLimitStall(state.lineNumber);
      } catch (error) {
        this.deps.logger.warn(
          { err: error, conversationKey: state.key, lineNumber: state.lineNumber },
          'failed to clear sms-limit stall on queue advance'
        );
      }
    }
    this.deps.smsLimitStallScheduler?.cancel(state.lineNumber);
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
    // Cancel any pending transient retry or SMS-limit stall before
    // resetting the queue. Without this, a stale retry timer can fire
    // after the conversation has rebuffered and call `runRetry` against
    // the new turn — `runRetry`'s identity check will catch most cases,
    // but cancelling the timers eagerly is cheaper and clearer.
    this.clearTransientRetry(state.key);
    this.deps.smsLimitStallScheduler?.cancel(state.lineNumber);
    if (this.deps.limitTracker) {
      try {
        await this.deps.limitTracker.clearSmsLimitStall(state.lineNumber);
      } catch (error) {
        this.deps.logger.warn(
          { err: error, conversationKey: state.key, lineNumber: state.lineNumber },
          'failed to clear sms-limit stall during interrupt'
        );
      }
    }

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
    await this.deps.scheduler.schedule(
      state.key,
      calculateBufferTimeout(1, this.deps.config),
      state.traceId ? { traceId: state.traceId } : undefined
    );
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

    const logger = this.traceLogger(state.traceId);
    if (item.kind === 'reply' && item.replyTo) {
      logger.info(
        { conversationKey: state.key, actionId: item.id, replyTo: item.replyTo },
        'sending contextual reply as normal Sendblue message'
      );
    }

    const statusCallback = `${this.deps.config.publicBaseUrl}/webhook/status`;
    // Send effects (sendStyle) are iMessage-only; safely degrade by dropping
    // them on SMS/downgraded conversations. The text/media still sends.
    const sendStyle = this.supportsImessageRichAction(state) ? item.sendStyle : undefined;
    if (item.sendStyle && !sendStyle) {
      logger.debug(
        { conversationKey: state.key, actionId: item.id, sendStyle: item.sendStyle },
        'dropping iMessage send effect on SMS or downgraded conversation'
      );
    }

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
      if (sendStyle) groupMessage.sendStyle = sendStyle;
      return client.sendGroupMessage(groupMessage);
    }

    const message: SendblueOutboundMessage = {
      toNumber: state.phoneNumber,
      content: item.content ?? '',
      statusCallback
    };
    if (item.mediaUrl) message.mediaUrl = item.mediaUrl;
    if (sendStyle) message.sendStyle = sendStyle;

    // NOTE: Sendblue routes purely by recipient capability detection. There
    // is no documented input parameter (was_downgraded, force_sms, channel,
    // protocol) on /api/send-message that overrides routing. If the
    // recipient has iMessage enabled, the message is sent via iMessage and
    // Apple's network queues it until the device is reachable. Replies to a
    // user temporarily off iMessage will arrive once they reconnect.
    logger.info(
      {
        conversationKey: state.key,
        toNumber: state.phoneNumber,
        channel: state.channel,
        smsDowngraded: state.smsDowngraded,
        hasMedia: Boolean(message.mediaUrl),
        sendStyle: message.sendStyle
      },
      'sending outbound direct message'
    );
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

    // Tapback reactions are direct iMessage-only. Suppress on SMS/downgraded.
    if (!this.supportsImessageRichAction(state)) {
      await this.skipCurrentAction(state, item, 'reactions are iMessage-only; suppressed on SMS or downgraded conversation');
      return undefined;
    }

    const messageHandle = this.resolveInboundTarget(item, state);
    if (!messageHandle) {
      await this.skipCurrentAction(state, item, 'reaction target did not resolve to an inbound messageHandle');
      return undefined;
    }

    const result = await client.sendReaction({
      messageHandle,
      reaction: item.reaction as SendblueReactionRequest['reaction'],
      partIndex: item.partIndex
    });
    // Drop the returned messageHandle. Sendblue's send-reaction endpoint
    // does not emit status callbacks (no DELIVERED/SENT/etc on reactions),
    // so retaining the handle would cause `sendCurrentMessage` to wait for
    // a status that never arrives — stalling the next outbound until
    // OUTBOUND_DELIVERY_TIMEOUT_MS (default 30s). With no handle, the
    // dispatch loop advances the queue immediately on success.
    return { raw: result.raw };
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
    this.traceLogger(state.traceId).warn(
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
    const logger = this.traceLogger(state.traceId);
    const client = this.deps.sendblueClient as RichSendblueClient;
    if (!client.markRead) {
      logger.warn(
        { conversationKey: state.key },
        'read receipt requested but Sendblue client does not implement markRead'
      );
      return;
    }

    if (this.deps.config.readReceiptDebounceMs > 0) {
      await new Promise(resolve => setTimeout(resolve, this.deps.config.readReceiptDebounceMs));
    }

    const startedAt = process.hrtime.bigint();
    try {
      const result = await client.markRead({ toNumber: state.phoneNumber });
      this.recordOutboundMetrics({
        operation: 'mark_read',
        channel: state.channel,
        result: 'success',
        errorCode: undefined,
        elapsedSec: elapsedSeconds(startedAt)
      });
      // Surface every attempt at info — the on-device "Read" indicator only
      // appears when Sendblue has read receipts enabled for the line
      // (contact support@sendblue.com to enable). Logging the call here lets
      // operators tell whether the agent is doing its part.
      logger.info(
        {
          conversationKey: state.key,
          toNumber: state.phoneNumber,
          status: result?.status,
          message: result?.message,
          errorCode: result?.errorCode
        },
        'read receipt sent'
      );
    } catch (error) {
      this.recordOutboundMetrics({
        operation: 'mark_read',
        channel: state.channel,
        result: 'error',
        errorCode: errorCodeFromException(error),
        elapsedSec: elapsedSeconds(startedAt)
      });
      logger.warn({ err: error, conversationKey: state.key }, 'read receipt failed');
    }
  }

  private shouldSendReadReceipt(state: ConversationRecord): boolean {
    // Sendblue's read-receipts docs (https://docs.sendblue.com/api-v2/read-receipts/)
    // explicitly say mark-read works for iMessage AND RCS, not SMS. Downgraded
    // conversations are SMS-eligible and should not call /api/mark-read.
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
    const traceLogger = this.traceLogger(state.traceId);
    const send = () => {
      this.deps.sendblueClient
        .sendTypingIndicator({ toNumber: state.phoneNumber })
        .catch(error => traceLogger.debug({ err: error, conversationKey: state.key }, 'typing indicator failed'));
    };

    // Defer the first call by typingStartDelayMs. Sendblue's iMessage typing
    // bubble persists on the device for ~60s after the last typing call, so a
    // chat endpoint that returns silence in <delay never lights up a bubble at
    // all. Long-running responses still see typing once the delay elapses.
    const refresh: TypingRefresh = {};
    const begin = () => {
      send();
      if (this.deps.config.typingRefreshIntervalMs > 0) {
        refresh.interval = setInterval(send, this.deps.config.typingRefreshIntervalMs);
      }
    };
    if (this.deps.config.typingStartDelayMs > 0) {
      refresh.start = setTimeout(begin, this.deps.config.typingStartDelayMs);
    } else {
      begin();
    }
    if (this.deps.config.typingRefreshMaxMs > 0) {
      refresh.max = setTimeout(() => this.stopTypingRefresh(state.key), this.deps.config.typingRefreshMaxMs);
    }
    this.typingRefreshes.set(state.key, refresh);
  }

  private stopTypingRefresh(conversationKey: string): void {
    const refresh = this.typingRefreshes.get(conversationKey);
    if (!refresh) return;
    if (refresh.start) clearTimeout(refresh.start);
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
    this.deps.metrics?.deliveryTimeoutFired.inc();
    await this.advanceQueue(state, messageHandle);
  }

  private clearDeliveryTimeout(messageHandle: string): void {
    const timeout = this.deliveryTimeouts.get(messageHandle);
    if (timeout) clearTimeout(timeout);
    this.deliveryTimeouts.delete(messageHandle);
  }

  // Channel-aware ordered-delivery gate. iMessage and RCS report DELIVERED;
  // SMS reports only SENT. RCS confirmed via Sendblue's RCS feature list
  // (https://docs.sendblue.com/api-v2/rcs/), which lists "delivery
  // confirmations" alongside read receipts.
  private successStatus(state: ConversationRecord): 'SENT' | 'DELIVERED' {
    return state.smsDowngraded || state.channel === 'sms' ? 'SENT' : 'DELIVERED';
  }

  // iMessage-only rich actions (send effects, reactions, outbound typing
  // indicators) must be suppressed for SMS, RCS, and downgraded conversations.
  // Per Sendblue's docs as of 2026-05-07:
  //   - /api-v2/reactions/ — "Reactions (tapbacks) are only supported for
  //     iMessage conversations. They are not supported for SMS or RCS."
  //   - /api-v2/typing-indicators/ — "Typing indicators are only supported
  //     for iMessage conversations, not SMS or RCS."
  //   - send_style is described as "iMessage expressive message style".
  // Read receipts have a separate gate (shouldSendReadReceipt) because
  // /api-v2/read-receipts/ documents support for both iMessage and RCS.
  private supportsImessageRichAction(state: ConversationRecord): boolean {
    return state.channel === 'imessage' && !state.smsDowngraded;
  }

  private shouldSendTypingIndicator(state: ConversationRecord): boolean {
    // Sendblue outbound typing indicators are direct iMessage-only.
    return (
      this.deps.config.outboundTypingIndicatorsEnabled &&
      state.type === 'direct' &&
      this.supportsImessageRichAction(state)
    );
  }

  private async transitionToIdle(state: ConversationRecord): Promise<void> {
    this.stopTypingRefresh(state.key);
    // Cancel any pending transient retry or SMS-limit stall — when the
    // conversation goes idle (chat returned silence, queue exhausted, or
    // the abort path ran), there is nothing to retry against.
    this.clearTransientRetry(state.key);
    this.deps.smsLimitStallScheduler?.cancel(state.lineNumber);
    if (this.deps.limitTracker) {
      try {
        await this.deps.limitTracker.clearSmsLimitStall(state.lineNumber);
      } catch (error) {
        this.deps.logger.warn(
          { err: error, conversationKey: state.key, lineNumber: state.lineNumber },
          'failed to clear sms-limit stall on idle'
        );
      }
    }
    // If an in-flight handle survived to here (e.g. timeout-driven idle),
    // drop its outbound-handle mapping so a late status callback cannot
    // reattach to a conversation that has already moved on.
    if (state.currentOutboundHandle) {
      this.clearDeliveryTimeout(state.currentOutboundHandle);
      await this.deps.store.deleteOutboundHandleMapping(state.currentOutboundHandle);
    }
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
    phoneNumber: string,
    logger: pino.Logger = this.deps.logger
  ): Promise<ConversationRecord['identity']> {
    if (!this.deps.identityResolver) return null;
    try {
      return await this.deps.identityResolver.resolveByPhone({ conversationKey, lineNumber, phoneNumber });
    } catch (error) {
      logger.warn({ err: error, conversationKey }, 'identity resolver failed open');
      return null;
    }
  }

  /**
   * Inline retry hook for `sendOutboundAction` failures (the synchronous
   * Sendblue HTTP path, e.g. a 429 surfaced as `SendblueApiError`).
   * Returns true when the error was handled by retry/stall (the caller
   * must NOT skip the action); false when the caller should fall through
   * to the existing skip path.
   */
  private async handleSendError(
    state: ConversationRecord,
    item: OutboundMessageItem,
    error: unknown
  ): Promise<boolean> {
    if (!this.deps.limitTracker) return false;
    const classification = this.deps.limitTracker.classifyError(error);
    if (classification === 'permanent') return false;

    if (classification === 'sms_limit') {
      return this.scheduleSmsLimitStall(state, item);
    }

    const attempts = (item.retryCount ?? 0) + 1;
    if (attempts > this.deps.limitTracker.transientRetryMaxAttempts()) {
      this.deps.metrics?.transientRetryTotal.inc({
        action: outboundOperationLabel(item.kind, state.type),
        outcome: 'exhausted'
      });
      this.traceLogger(state.traceId).warn(
        { conversationKey: state.key, lineNumber: state.lineNumber, attempts },
        'transient retry budget exhausted; falling through to skip/abort'
      );
      return false;
    }
    return this.scheduleTransientRetry(state, item, attempts);
  }

  /**
   * Status-callback retry hook. Same classification + budget as
   * `handleSendError`, but driven by the Sendblue ERROR/DECLINED webhook
   * (the queue is in 'sending' state, the item already has a messageHandle
   * mapped). Returns true when retry/stall scheduled; caller should skip
   * the abortQueue path.
   */
  private async maybeRetryFromStatus(
    state: ConversationRecord,
    update: SendblueStatusWebhook
  ): Promise<boolean> {
    if (!this.deps.limitTracker) return false;
    const classification = this.deps.limitTracker.classifyStatusErrorCode(update.errorCode);
    if (classification === 'permanent') return false;

    // Drop the in-flight handle's mapping and timeout; the next attempt
    // will create a fresh one when sendCurrentMessage runs again.
    if (update.messageHandle) {
      this.clearDeliveryTimeout(update.messageHandle);
      await this.deps.store.deleteOutboundHandleMapping(update.messageHandle);
    }

    const item = state.outboundQueue[state.currentOutboundIndex];
    if (!item) return false;

    if (classification === 'sms_limit') {
      // Clear the failed send's metadata so the retry resends fresh.
      const cleared: OutboundMessageItem = {
        ...item,
        messageHandle: undefined,
        sentAt: undefined
      };
      state.outboundQueue[state.currentOutboundIndex] = cleared;
      state.currentOutboundHandle = undefined;
      await this.persist(state);
      return this.scheduleSmsLimitStall(state, cleared);
    }

    const attempts = (item.retryCount ?? 0) + 1;
    if (attempts > this.deps.limitTracker.transientRetryMaxAttempts()) {
      this.deps.metrics?.transientRetryTotal.inc({
        action: outboundOperationLabel(item.kind, state.type),
        outcome: 'exhausted'
      });
      this.traceLogger(state.traceId).warn(
        {
          conversationKey: state.key,
          lineNumber: state.lineNumber,
          attempts,
          errorCode: update.errorCode
        },
        'transient retry budget exhausted on status callback; aborting queue'
      );
      return false;
    }
    return this.scheduleTransientRetry(state, item, attempts);
  }

  private async scheduleTransientRetry(
    state: ConversationRecord,
    item: OutboundMessageItem,
    attempts: number
  ): Promise<boolean> {
    if (!this.deps.limitTracker) return false;
    const delayMs = this.deps.limitTracker.retryDelayMs(attempts);
    const nextRetryAt = new Date(this.nowMs() + delayMs).toISOString();
    state.outboundQueue[state.currentOutboundIndex] = {
      ...item,
      retryCount: attempts,
      nextRetryAt,
      messageHandle: undefined,
      sentAt: undefined
    };
    state.currentOutboundHandle = undefined;
    await this.persist(state);

    this.deps.metrics?.transientRetryTotal.inc({
      action: outboundOperationLabel(item.kind, state.type),
      outcome: 'scheduled'
    });
    const retryLogger = this.traceLogger(state.traceId);
    retryLogger.warn(
      {
        conversationKey: state.key,
        lineNumber: state.lineNumber,
        actionKind: item.kind,
        attempts,
        delayMs,
        nextRetryAt
      },
      'scheduling transient retry for outbound action'
    );

    this.clearTransientRetry(state.key);
    const action = outboundOperationLabel(item.kind, state.type);
    const traceId = state.traceId;
    // Capture the item-identity snapshot at scheduling time. `runRetry` uses
    // it to drop a stale retry that fires after the queue has advanced or
    // been interrupted (e.g. delivery-timeout-then-retry race).
    const expected = { itemId: item.id, retryCount: attempts };
    const timer = setTimeout(() => {
      this.transientRetryTimers.delete(state.key);
      this.deps.metrics?.transientRetryTotal.inc({ action, outcome: 'executed' });
      this.runRetry(state.key, expected, traceId).catch(error =>
        this.traceLogger(traceId).warn(
          { err: error, conversationKey: state.key },
          'transient retry execution failed'
        )
      );
    }, delayMs);
    this.transientRetryTimers.set(state.key, timer);
    return true;
  }

  /**
   * Persist the SMS-limit stall, enforce `smsLimitMaxAttempts`, and arm the
   * in-process retry timer. Returns `false` (so the caller falls through to
   * `abortQueue`) when:
   *
   * - No `smsLimitStallScheduler` is wired (degenerate case).
   * - The persisted attempt counter has already exceeded
   *   `smsLimitMaxAttempts` — at which point we stop looping and let the
   *   queue abort.
   *
   * The persisted `SmsLimitStall` includes `conversationKey` so a fresh
   * process at boot can replay the stall via `recoverPendingRetries`.
   */
  private async scheduleSmsLimitStall(
    state: ConversationRecord,
    item: OutboundMessageItem
  ): Promise<boolean> {
    if (!this.deps.smsLimitStallScheduler) return false;
    const intervalMs = this.deps.config.smsLimitRetryIntervalMs;
    const maxAttempts = this.deps.limitTracker?.smsLimitMaxAttempts() ?? this.deps.config.smsLimitMaxAttempts;
    const stallLogger = this.traceLogger(state.traceId);

    const existing = this.deps.limitTracker
      ? await this.deps.limitTracker.getSmsLimitStall(state.lineNumber)
      : undefined;
    const attempts = (existing?.attempts ?? 0) + 1;
    if (attempts > maxAttempts) {
      this.deps.metrics?.smsLimitStallTotal.inc({ event: 'exhausted' });
      stallLogger.error(
        {
          conversationKey: state.key,
          lineNumber: state.lineNumber,
          attempts,
          maxAttempts
        },
        'SMS_LIMIT_REACHED retry budget exhausted; falling through to abort'
      );
      // Clear the persisted stall so the next 5509 starts a fresh counter.
      if (this.deps.limitTracker) {
        try {
          await this.deps.limitTracker.clearSmsLimitStall(state.lineNumber);
        } catch (error) {
          this.deps.logger.warn(
            { err: error, conversationKey: state.key, lineNumber: state.lineNumber },
            'failed to clear sms-limit stall after exhaustion'
          );
        }
      }
      return false;
    }

    const nextRetryAt = new Date(this.nowMs() + intervalMs);
    if (this.deps.limitTracker) {
      try {
        await this.deps.limitTracker.setSmsLimitStall(state.lineNumber, {
          attempts,
          nextRetryAt,
          conversationKey: state.key
        });
      } catch (error) {
        // Persistence failures should not prevent the in-process timer from
        // arming — the operator just loses telemetry + restart-recovery
        // for this stall.
        stallLogger.warn(
          { err: error, conversationKey: state.key, lineNumber: state.lineNumber },
          'failed to persist sms-limit stall metadata; timer still armed'
        );
      }
    }

    this.deps.metrics?.smsLimitStallTotal.inc({ event: 'enter' });
    stallLogger.error(
      {
        conversationKey: state.key,
        lineNumber: state.lineNumber,
        intervalMs,
        attempts,
        maxAttempts,
        nextRetryAt: nextRetryAt.toISOString()
      },
      'SMS_LIMIT_REACHED — stalling per-line outbound queue and scheduling retry'
    );
    const conversationKey = state.key;
    const lineNumber = state.lineNumber;
    const traceId = state.traceId;
    const expected = { itemId: item.id, retryCount: item.retryCount ?? 0 };
    this.deps.smsLimitStallScheduler.schedule(
      lineNumber,
      () => {
        this.deps.metrics?.smsLimitStallTotal.inc({ event: 'retry_executed' });
        return this.runRetry(conversationKey, expected, traceId).catch(error =>
          this.traceLogger(traceId).warn(
            { err: error, conversationKey, lineNumber },
            'sms-limit stall retry execution failed'
          )
        );
      },
      intervalMs
    );
    this.deps.metrics?.smsLimitStallTotal.inc({ event: 'retry_scheduled' });
    return true;
  }

  private async runRetry(
    conversationKey: string,
    expected: { itemId: string; retryCount: number },
    traceId?: string
  ): Promise<void> {
    const state = withConversationDefaults(await this.deps.store.getConversation(conversationKey));
    if (!state) return;
    if (state.state !== 'sending') return;
    const item = state.outboundQueue[state.currentOutboundIndex];
    if (!item || item.id !== expected.itemId || (item.retryCount ?? 0) !== expected.retryCount) {
      // The queued item changed between scheduling and firing — likely an
      // interrupt or delivery-timeout advance. Drop the stale retry rather
      // than re-sending whatever the queue has now.
      this.traceLogger(traceId).debug(
        {
          conversationKey,
          expected,
          actual: item ? { id: item.id, retryCount: item.retryCount ?? 0 } : undefined
        },
        'retry item-identity mismatch; dropping stale retry'
      );
      return;
    }
    await this.sendCurrentMessage(state);
  }

  private clearTransientRetry(conversationKey: string): void {
    const timer = this.transientRetryTimers.get(conversationKey);
    if (timer) clearTimeout(timer);
    this.transientRetryTimers.delete(conversationKey);
  }

  /**
   * Upsert Sendblue contacts triggered by an inbound message. Direct inbound
   * upserts the speaker; group inbound iterates `participants[]`, runs
   * identity lookup per participant, and upserts each that returns a name.
   *
   * The dedupe SETNX claim on the conversation store prevents a single
   * conversation from re-burning the contacts API on every inbound, while
   * the per-line scoping means the same number on different lines can still
   * be tracked separately.
   */
  private async upsertContactsForReceive(
    webhook: SendblueReceiveWebhook,
    senderIdentity: ConversationRecord['identity'],
    lineNumber: string,
    phoneNumber: string,
    groupId: string | undefined
  ): Promise<void> {
    if (!this.deps.config.sendblueContactsEnabled) return;
    const client = this.deps.sendblueClient as RichSendblueClient;
    if (!client.createContact) {
      this.deps.logger.debug(
        { lineNumber, phoneNumber },
        'contact upsert requested but Sendblue client does not implement createContact'
      );
      return;
    }

    const tasks: Array<{ phoneNumber: string; identity: ConversationRecord['identity']; conversationKey: string }> = [];
    if (!groupId) {
      tasks.push({
        phoneNumber,
        identity: senderIdentity,
        conversationKey: directConversationKey(lineNumber, phoneNumber)
      });
    } else {
      const groupKey = groupConversationKey(lineNumber, groupId);
      // Speaker first (we already have their identity from the inbound flow),
      // then each participant — sequential to keep single-flight semantics
      // and avoid bursting Sendblue's contacts rate budget.
      tasks.push({ phoneNumber, identity: senderIdentity, conversationKey: groupKey });
      for (const participant of extractParticipantNumbers(webhook.participants, this.deps.logger)) {
        if (participant === lineNumber || participant === phoneNumber) continue;
        const identity = await this.resolveIdentity(groupKey, lineNumber, participant);
        tasks.push({ phoneNumber: participant, identity, conversationKey: groupKey });
      }
    }

    for (const task of tasks) {
      const claimed = await this.deps.store.claimContactUpsert(
        lineNumber,
        task.phoneNumber,
        this.deps.config.sendblueContactsDedupeTtlSeconds
      );
      if (!claimed) {
        this.deps.logger.debug(
          { lineNumber, phoneNumber: task.phoneNumber, conversationKey: task.conversationKey },
          'contact upsert skipped: already claimed within dedupe TTL'
        );
        continue;
      }

      const outcome = await upsertContactFromIdentity({
        client,
        phoneNumber: task.phoneNumber,
        sendblueNumber: lineNumber,
        identity: task.identity,
        defaultTags: this.deps.config.sendblueContactsDefaultTags,
        logger: this.deps.logger
      });
      if (!outcome.upserted) {
        this.deps.logger.debug(
          {
            lineNumber,
            phoneNumber: task.phoneNumber,
            conversationKey: task.conversationKey,
            reason: outcome.reason
          },
          'contact upsert skipped'
        );
      }
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

    // Substring match against prior agent messages is a soft heuristic — short
    // agent replies like "yes" cause false positives ("yes please" invokes
    // the agent). Gated on `GROUP_INVOCATION_CONTENT_FALLBACK` so deployments
    // can opt out while keeping legacy behavior the default.
    if (!current || !this.deps.config.groupInvocationContentFallback) return false;
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

  /**
   * Build a pino child logger that carries the conversation's traceId when one
   * is available. Used inside the deeper outbound / status callee paths so log
   * lines stay correlated with the original webhook trace even when no
   * RequestContext was threaded through. Falls back to the base logger when
   * traceId is undefined (e.g. records persisted by a pre-trace process).
   */
  private traceLogger(traceId: string | undefined): pino.Logger {
    return traceId ? this.deps.logger.child({ traceId }) : this.deps.logger;
  }

  private recordOutboundMetrics(args: {
    operation: string;
    channel: ConversationChannel;
    result: 'success' | 'error' | 'suppressed';
    errorCode: string | undefined;
    elapsedSec: number;
  }): void {
    const metrics = this.deps.metrics;
    if (!metrics) return;
    metrics.outboundSendDuration.observe(
      { operation: args.operation, result: args.result },
      args.elapsedSec
    );
    metrics.outboundSendTotal.inc({
      operation: args.operation,
      channel: args.channel,
      result: args.result,
      error_code: normalizeErrorCodeLabel(args.errorCode)
    });
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

function isOutboundMessageKind(kind: OutboundMessageItem['kind']): boolean {
  return kind === 'message' || kind === 'media' || kind === 'reply';
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

/**
 * Pull E.164-shaped phone strings out of Sendblue's group `participants`
 * field. The parser preserves it as `unknown` because Sendblue documents
 * both flat string arrays and `{ number, name }` object arrays for groups;
 * be defensive about both shapes and silently drop anything that doesn't
 * look like a phone number.
 */
function elapsedSeconds(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / 1e9;
}

function outboundOperationLabel(
  kind: OutboundMessageItem['kind'],
  type: ConversationRecord['type']
): string {
  if (kind === 'reaction') return 'reaction';
  if (kind === 'silence') return 'silence';
  return type === 'group' ? 'group' : 'message';
}

function errorCodeFromException(error: unknown): string | undefined {
  if (error instanceof SendblueApiError) return error.errorCode ?? undefined;
  return undefined;
}

function extractParticipantNumbers(participants: unknown, logger?: pino.Logger): string[] {
  if (!Array.isArray(participants)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of participants) {
    let value: string | undefined;
    if (typeof entry === 'string') value = entry;
    else if (entry && typeof entry === 'object') {
      const record = entry as Record<string, unknown>;
      const candidate = record.number ?? record.phoneNumber ?? record.phone;
      if (typeof candidate === 'string') value = candidate;
      else if (logger) {
        // Surface unexpected participant payload shapes at debug. Sendblue
        // documents `participants` as either a flat string array or
        // `{ number, name }` objects; if a future API change introduces a
        // different key (e.g. `id`, `e164`), we want operational signal in
        // logs without throwing or short-circuiting the rest of the array.
        logger.debug(
          { shape: Object.keys(record) },
          'unrecognized participant shape; skipped'
        );
      }
    }
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}
