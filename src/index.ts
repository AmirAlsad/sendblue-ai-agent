import 'dotenv/config';
import { loadConfig, type AgentConfig } from './config/env.js';
import { HttpChatClient } from './chat/client.js';
import { HttpSendblueClient } from './sendblue/client.js';
import { createApp } from './http/app.js';

export { loadConfig, type AgentConfig } from './config/env.js';
export { createApp, type AppDependencies } from './http/app.js';
export { HttpChatClient, normalizeChatResponse, parseTaggedText, ChatEndpointError } from './chat/client.js';
export { resolveTargetRef, type TargetResolution, type TargetResolverMessage } from './chat/target-resolver.js';
export {
  createChatRequest,
  DEFAULT_CHAT_RESPONSE_TAGS,
  IMESSAGE_ONLY_ACTION_TYPES,
  type ChatAction,
  type ChatContractWarning,
  type ChatEndpointRequest,
  type ChatEndpointResponse,
  type ChatResponseTagNames,
  type ImessageOnlyActionType,
  type NormalizedChatEndpointResponse,
  type TargetRef
} from './chat/types.js';
export { HttpSendblueClient, SendblueApiError, type SendblueClient } from './sendblue/client.js';
export { ConversationAgent } from './conversation/agent.js';
export { calculateBufferTimeout } from './conversation/buffering.js';
export { InMemoryConversationStore, type ConversationStore } from './conversation/store.js';
export { RedisConversationStore } from './conversation/redis-store.js';
export { InMemoryBufferScheduler, BullMqBufferScheduler, type BufferScheduler } from './conversation/scheduler.js';
export { HttpIdentityResolver, type IdentityResolver } from './identity/resolver.js';
export {
  parseReceiveWebhook,
  parseStatusWebhook,
  parseTypingIndicatorWebhook,
  parseSendblueStatus
} from './sendblue/parser.js';
export type {
  SendblueReceiveWebhook,
  SendblueStatus,
  SendblueStatusWebhook,
  SendblueActionResult,
  SendblueMarkReadRequest,
  SendblueOutboundGroupMessage,
  SendblueOutboundMessage,
  SendblueReaction,
  SendblueReactionRequest,
  SendblueSendResult,
  SendblueSendStyle,
  SendblueTypingIndicator,
  SendblueTypingIndicatorResult
} from './sendblue/types.js';
export { applyStatusUpdate, InMemoryStatusStore, TERMINAL_STATUSES } from './status/tracker.js';
export {
  InMemoryMetricsCollector,
  NoopMetricsCollector,
  type MetricsCollector,
  type Counter,
  type Gauge,
  type Histogram,
  type LabelValues,
  type MetricsSnapshot
} from './metrics/collector.js';
export { renderPrometheus, PROMETHEUS_CONTENT_TYPE } from './metrics/prometheus.js';
export { createAgentMetrics, type AgentMetrics } from './metrics/registry.js';
export { traceMiddleware, requestContextFromLocals, type RequestContext } from './http/trace.js';
export { redactPhone, redactContent, redactConversationRecord, redactStatusRecord } from './http/redaction.js';

export function start(config: AgentConfig = loadConfig()) {
  const { app, close } = createApp({
    config,
    chatClient: new HttpChatClient(config),
    sendblueClient: new HttpSendblueClient(config)
  });

  return new Promise<{ port: number; close: () => Promise<void> }>((resolve, reject) => {
    const server = app.listen(config.port, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : config.port;
      resolve({
        port,
        close: () =>
          new Promise((closeResolve, closeReject) => {
            server.close(error => {
              if (error) {
                closeReject(error);
                return;
              }
              close().then(closeResolve, closeReject);
            });
          })
      });
    });
    server.on('error', reject);
  });
}

if (process.env.AGENT_AUTOSTART !== '0' && process.env.NODE_ENV !== 'test') {
  start().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
