import express from 'express';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpChatClient } from '../../src/chat/client.js';
import type { ChatEndpointRequest } from '../../src/chat/types.js';
import { loadConfig } from '../../src/config/env.js';
import { createApp } from '../../src/http/app.js';
import { HttpSendblueClient } from '../../src/sendblue/client.js';
import { InMemoryStatusStore } from '../../src/status/tracker.js';
import {
  assertNativeMessagesPrerequisites,
  pollMessagesDbForReply,
  sendTestIMessage
} from '../../scripts/e2e/lib/messages.js';
import { startNgrokTunnel, type StartedNgrokTunnel } from '../../scripts/e2e/lib/ngrok.js';
import { SendblueWebhookClient } from '../../scripts/e2e/lib/sendblue-webhooks.js';
import { loadE2EEnv, type E2EEnv } from './helpers/env.js';
import { waitFor } from './helpers/wait.js';

describe('Sendblue real-device round trip', () => {
  let env: E2EEnv;
  let chatCalls: ChatEndpointRequest[] = [];
  let chatServer: Server;
  let agentServer: Server;
  let ngrok: StartedNgrokTunnel | undefined;
  let statusStore: InMemoryStatusStore;
  let closeAgentApp: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    env = loadE2EEnv();
    await assertNativeMessagesPrerequisites(env.messagesDbPath);

    const chatApp = express();
    chatApp.use(express.json({ limit: '1mb' }));
    chatApp.post('/chat', (req, res) => {
      chatCalls.push(req.body);
      const match = /\[sendblue-e2e:([^\]]+)\]/.exec(String(req.body?.message ?? ''));
      const id = match?.[1] ?? 'missing-id';
      res.json({ message: `[sendblue-e2e-reply:${id}] received` });
    });
    chatServer = await new Promise<Server>((resolve, reject) => {
      const listener = chatApp.listen(0, () => resolve(listener));
      listener.on('error', reject);
    });
    const chatPort = (chatServer.address() as { port: number }).port;
    const publicBaseUrl = env.publicBaseUrl ?? (ngrok = await startNgrokTunnel(env)).publicUrl;
    const agentConfig = loadConfig({
      ...process.env,
      PORT: String(env.agentPort),
      PUBLIC_BASE_URL: publicBaseUrl,
      CHAT_ENDPOINT_URL: `http://localhost:${chatPort}/chat`,
      CHAT_ENDPOINT_TIMEOUT_MS: '10000',
      SENDBLUE_API_BASE_URL: env.sendblueApiBaseUrl,
      SENDBLUE_API_KEY_ID: env.sendblueApiKeyId,
      SENDBLUE_API_SECRET_KEY: env.sendblueApiSecretKey,
      SENDBLUE_FROM_NUMBER: env.sendblueFromNumber,
      SENDBLUE_WEBHOOK_SECRET: env.sendblueWebhookSecret,
      SENDBLUE_WEBHOOK_SECRET_HEADER: env.sendblueWebhookSecretHeader
    });

    statusStore = new InMemoryStatusStore();
    const created = createApp({
      config: agentConfig,
      chatClient: new HttpChatClient(agentConfig),
      sendblueClient: new HttpSendblueClient(agentConfig),
      statusStore
    });
    const { app } = created;
    closeAgentApp = created.close;

    agentServer = await new Promise<Server>((resolve, reject) => {
      const listener = app.listen(env.agentPort, () => resolve(listener));
      listener.on('error', reject);
    });

    await new SendblueWebhookClient(env).apply(publicBaseUrl);
  });

  afterAll(async () => {
    if (agentServer) await new Promise<void>(resolve => agentServer.close(() => resolve()));
    if (closeAgentApp) await closeAgentApp();
    if (chatServer) await new Promise<void>(resolve => chatServer.close(() => resolve()));
    if (ngrok) await ngrok.close();
  });

  it('sends a real iMessage through Sendblue and observes the reply', async () => {
    const id = randomUUID();
    const inbound = `[sendblue-e2e:${id}] hello`;
    const expectedReply = `[sendblue-e2e-reply:${id}] received`;
    const startedAt = Date.now();

    await sendTestIMessage({ to: env.sendblueFromNumber, content: inbound });

    await waitFor(
      () => chatCalls.find(call => call.message.includes(`[sendblue-e2e:${id}]`)),
      { label: 'Sendblue receive webhook and chat endpoint call', timeoutMs: 45000 }
    );

    const terminalStatus = await waitFor(
      () =>
        statusStore
          .all()
          .find(record => record.terminalStatus === 'DELIVERED' || record.terminalStatus === 'ERROR'),
      { label: 'terminal Sendblue status callback', timeoutMs: 45000 }
    );

    expect(terminalStatus.terminalStatus).toBe('DELIVERED');

    const reply = await pollMessagesDbForReply({
      from: env.sendblueFromNumber,
      contains: expectedReply,
      since: startedAt,
      dbPath: env.messagesDbPath,
      timeoutMs: 45000
    });

    expect(reply.text).toContain(expectedReply);
    expect(chatCalls.filter(call => call.message.includes(`[sendblue-e2e:${id}]`))).toHaveLength(1);
  });
});
