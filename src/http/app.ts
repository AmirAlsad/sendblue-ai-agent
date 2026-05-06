import express, { type Request, type Response } from 'express';
import pino from 'pino';
import type { AgentConfig } from '../config/env.js';
import { type ChatClient, ChatEndpointError } from '../chat/client.js';
import { createChatRequest } from '../chat/types.js';
import { type SendblueClient } from '../sendblue/client.js';
import { parseOperationalWebhook, parseReceiveWebhook, parseStatusWebhook } from '../sendblue/parser.js';
import {
  SENDBLUE_WEBHOOK_TYPES,
  sendblueOperationalWebhookTypeFromPath,
  sendblueWebhookPath
} from '../sendblue/webhook-types.js';
import { InMemoryStatusStore } from '../status/tracker.js';
import { validateWebhookSecret } from './security.js';

export type AppDependencies = {
  config: AgentConfig;
  chatClient: ChatClient;
  sendblueClient: SendblueClient;
  statusStore?: InMemoryStatusStore;
  logger?: pino.Logger;
};

export function createApp(deps: AppDependencies) {
  const app = express();
  const statusStore = deps.statusStore ?? new InMemoryStatusStore();
  const seenReceiveHandles = new Set<string>();
  const logger = deps.logger ?? pino({ level: process.env.LOG_LEVEL || 'info' });

  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  app.post('/webhook/receive', async (req: Request, res: Response) => {
    if (!validateWebhookSecret(req, deps.config)) {
      res.status(401).json({ error: 'invalid webhook secret' });
      return;
    }

    let webhook;
    try {
      webhook = parseReceiveWebhook(req.body);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : 'invalid payload' });
      return;
    }

    if (seenReceiveHandles.has(webhook.messageHandle)) {
      res.status(200).json({ ok: true, duplicate: true });
      return;
    }
    seenReceiveHandles.add(webhook.messageHandle);

    try {
      const chatResponse = await deps.chatClient.complete(createChatRequest(webhook));
      if ('silence' in chatResponse && chatResponse.silence === true) {
        res.status(202).json({ ok: true, sent: 0 });
        return;
      }

      const statusCallback = `${deps.config.publicBaseUrl}/webhook/status`;
      for (const message of chatResponse.messages) {
        await deps.sendblueClient.sendMessage({
          toNumber: webhook.fromNumber,
          content: message,
          statusCallback
        });
      }

      res.status(202).json({ ok: true, sent: chatResponse.messages.length });
    } catch (error) {
      logger.warn(
        {
          err: error,
          messageHandle: webhook.messageHandle,
          chatEndpointError: error instanceof ChatEndpointError
        },
        'failed to process receive webhook'
      );
      res.status(502).json({ error: 'failed to process message' });
    }
  });

  app.post('/webhook/status', (req: Request, res: Response) => {
    if (!validateWebhookSecret(req, deps.config)) {
      res.status(401).json({ error: 'invalid webhook secret' });
      return;
    }

    try {
      const update = parseStatusWebhook(req.body);
      const record = statusStore.apply(update);
      res.status(200).json({ ok: true, record });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : 'invalid payload' });
    }
  });

  app.post(
    SENDBLUE_WEBHOOK_TYPES.filter(type => type !== 'receive' && type !== 'outbound').map(sendblueWebhookPath),
    (req: Request, res: Response) => {
      if (!validateWebhookSecret(req, deps.config)) {
        res.status(401).json({ error: 'invalid webhook secret' });
        return;
      }

      const webhookType = sendblueOperationalWebhookTypeFromPath(req.path);
      try {
        const webhook = parseOperationalWebhook(req.body);
        logger.info(
          {
            webhookType,
            messageHandle: webhook.messageHandle,
            status: webhook.status
          },
          'received Sendblue operational webhook'
        );
        res.status(202).json({ ok: true, type: webhookType });
      } catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : 'invalid payload' });
      }
    }
  );

  return { app, statusStore };
}
