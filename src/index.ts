import 'dotenv/config';
import { loadConfig, type AgentConfig } from './config/env.js';
import { HttpChatClient } from './chat/client.js';
import { HttpSendblueClient } from './sendblue/client.js';
import { createApp } from './http/app.js';

export { loadConfig, type AgentConfig } from './config/env.js';
export { createApp, type AppDependencies } from './http/app.js';
export { HttpChatClient, normalizeChatResponse, ChatEndpointError } from './chat/client.js';
export { createChatRequest, type ChatEndpointRequest, type ChatEndpointResponse } from './chat/types.js';
export { HttpSendblueClient, type SendblueClient } from './sendblue/client.js';
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
  SendblueOutboundMessage,
  SendblueSendResult
} from './sendblue/types.js';
export { applyStatusUpdate, InMemoryStatusStore, TERMINAL_STATUSES } from './status/tracker.js';

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
