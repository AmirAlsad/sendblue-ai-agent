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
export { parseReceiveWebhook, parseStatusWebhook, parseSendblueStatus } from './sendblue/parser.js';
export type {
  SendblueReceiveWebhook,
  SendblueStatus,
  SendblueStatusWebhook,
  SendblueOutboundMessage,
  SendblueSendResult
} from './sendblue/types.js';
export { applyStatusUpdate, InMemoryStatusStore, TERMINAL_STATUSES } from './status/tracker.js';

export function start(config: AgentConfig = loadConfig()) {
  const { app } = createApp({
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
              if (error) closeReject(error);
              else closeResolve();
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
