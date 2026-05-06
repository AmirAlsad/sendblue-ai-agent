import express from 'express';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpChatClient } from '../../src/chat/client.js';
import type { ChatEndpointRequest } from '../../src/chat/types.js';
import { createApp } from '../../src/http/app.js';
import { HttpSendblueClient } from '../../src/sendblue/client.js';
import { InMemoryStatusStore } from '../../src/status/tracker.js';
import {
  assertNativeMessagesPrerequisites,
  pollMessagesDbForReply,
  sendTestIMessage
} from '../../scripts/e2e/lib/messages.js';
import { loadE2EEnv, type E2EEnv } from './helpers/env.js';
import { waitFor } from './helpers/wait.js';

describe('Sendblue real-device round trip', () => {
  let env: E2EEnv;
  let chatCalls: ChatEndpointRequest[] = [];
  let chatServer: Server;
  let agentServer: Server;
  let statusStore: InMemoryStatusStore;

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

    statusStore = new InMemoryStatusStore();
    const { app } = createApp({
      config: {
        port: env.agentPort,
        publicBaseUrl: env.publicBaseUrl,
        chatEndpointUrl: `http://localhost:${chatPort}/chat`,
        chatEndpointTimeoutMs: 10000,
        sendblueApiBaseUrl: env.sendblueApiBaseUrl,
        sendblueApiKeyId: env.sendblueApiKeyId,
        sendblueApiSecretKey: env.sendblueApiSecretKey,
        sendblueFromNumber: env.sendblueFromNumber,
        sendblueWebhookSecret: env.sendblueWebhookSecret,
        sendblueWebhookSecretHeader: env.sendblueWebhookSecretHeader
      },
      chatClient: new HttpChatClient({
        port: env.agentPort,
        publicBaseUrl: env.publicBaseUrl,
        chatEndpointUrl: `http://localhost:${chatPort}/chat`,
        chatEndpointTimeoutMs: 10000,
        sendblueApiBaseUrl: env.sendblueApiBaseUrl,
        sendblueApiKeyId: env.sendblueApiKeyId,
        sendblueApiSecretKey: env.sendblueApiSecretKey,
        sendblueFromNumber: env.sendblueFromNumber,
        sendblueWebhookSecret: env.sendblueWebhookSecret,
        sendblueWebhookSecretHeader: env.sendblueWebhookSecretHeader
      }),
      sendblueClient: new HttpSendblueClient({
        port: env.agentPort,
        publicBaseUrl: env.publicBaseUrl,
        chatEndpointUrl: `http://localhost:${chatPort}/chat`,
        chatEndpointTimeoutMs: 10000,
        sendblueApiBaseUrl: env.sendblueApiBaseUrl,
        sendblueApiKeyId: env.sendblueApiKeyId,
        sendblueApiSecretKey: env.sendblueApiSecretKey,
        sendblueFromNumber: env.sendblueFromNumber,
        sendblueWebhookSecret: env.sendblueWebhookSecret,
        sendblueWebhookSecretHeader: env.sendblueWebhookSecretHeader
      }),
      statusStore
    });

    agentServer = await new Promise<Server>((resolve, reject) => {
      const listener = app.listen(env.agentPort, () => resolve(listener));
      listener.on('error', reject);
    });

  });

  afterAll(async () => {
    if (agentServer) await new Promise<void>(resolve => agentServer.close(() => resolve()));
    if (chatServer) await new Promise<void>(resolve => chatServer.close(() => resolve()));
  });

  it('sends a real iMessage through Sendblue and observes the reply', async () => {
    const id = randomUUID();
    const inbound = `[sendblue-e2e:${id}] hello`;
    const expectedReply = `[sendblue-e2e-reply:${id}] received`;
    const startedAt = Date.now();

    await sendTestIMessage({ to: env.sendblueNumber, content: inbound });

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
      from: env.sendblueNumber,
      contains: expectedReply,
      since: startedAt,
      dbPath: env.messagesDbPath,
      timeoutMs: 45000
    });

    expect(reply.text).toContain(expectedReply);
    expect(chatCalls.filter(call => call.message.includes(`[sendblue-e2e:${id}]`))).toHaveLength(1);
  });
});
