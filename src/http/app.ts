import express, { type Request, type Response } from 'express';
import pino from 'pino';
import type { AgentConfig } from '../config/env.js';
import { type ChatClient, ChatEndpointError } from '../chat/client.js';
import { ConversationAgent } from '../conversation/agent.js';
import { BullMqBufferScheduler, InMemoryBufferScheduler, type BufferScheduler } from '../conversation/scheduler.js';
import { InMemoryConversationStore, type ConversationStore } from '../conversation/store.js';
import { RedisConversationStore } from '../conversation/redis-store.js';
import { HttpIdentityResolver, type IdentityResolver } from '../identity/resolver.js';
import { type SendblueClient } from '../sendblue/client.js';
import {
  parseOperationalWebhook,
  parseReceiveWebhook,
  parseStatusWebhook,
  parseTypingIndicatorWebhook
} from '../sendblue/parser.js';
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
  conversationStore?: ConversationStore;
  bufferScheduler?: BufferScheduler;
  identityResolver?: IdentityResolver;
  webhookObserver?: (envelope: ObservedWebhookEnvelope) => void | Promise<void>;
  logger?: pino.Logger;
};

export type ObservedWebhookEnvelope = {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  rawBody?: string;
  receivedAt: string;
  path: string;
};

type RawBodyRequest = Request & { rawBody?: string };

export function createApp(deps: AppDependencies) {
  const app = express();
  const statusStore = deps.statusStore ?? new InMemoryStatusStore();
  const logger = deps.logger ?? pino({ level: process.env.LOG_LEVEL || 'info' });
  const conversationStore =
    deps.conversationStore ??
    (deps.config.redisUrl
      ? new RedisConversationStore(deps.config)
      : new InMemoryConversationStore(deps.config));
  const bufferScheduler =
    deps.bufferScheduler ??
    (deps.config.redisUrl
      ? new BullMqBufferScheduler(deps.config, logger)
      : new InMemoryBufferScheduler());
  const identityResolver =
    deps.identityResolver ??
    (deps.config.userLookupUrl ? new HttpIdentityResolver(deps.config) : undefined);
  const conversationAgent = new ConversationAgent({
    config: deps.config,
    chatClient: deps.chatClient,
    sendblueClient: deps.sendblueClient,
    statusStore,
    store: conversationStore,
    scheduler: bufferScheduler,
    identityResolver,
    logger
  });

  app.use(
    express.json({
      limit: '1mb',
      verify: (req, _res, buffer) => {
        (req as RawBodyRequest).rawBody = buffer.toString('utf8');
      }
    })
  );

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  app.post('/webhook/receive', async (req: Request, res: Response) => {
    await observeWebhook(req, deps.webhookObserver, logger);
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

    try {
      const result = await conversationAgent.handleReceive(webhook);
      res.status('duplicate' in result && result.duplicate ? 200 : 202).json(result);
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

  app.post('/webhook/status', async (req: Request, res: Response) => {
    await observeWebhook(req, deps.webhookObserver, logger);
    if (!validateWebhookSecret(req, deps.config)) {
      res.status(401).json({ error: 'invalid webhook secret' });
      return;
    }

    try {
      const update = parseStatusWebhook(req.body);
      const result = await conversationAgent.handleStatus(update);
      res.status(200).json(result);
    } catch (error) {
      logger.warn({ err: error }, 'failed to process status callback');
      res.status(400).json({ error: error instanceof Error ? error.message : 'invalid payload' });
    }
  });

  app.post('/webhook/typing-indicator', async (req: Request, res: Response) => {
    await observeWebhook(req, deps.webhookObserver, logger);
    if (!validateWebhookSecret(req, deps.config)) {
      res.status(401).json({ error: 'invalid webhook secret' });
      return;
    }

    try {
      const webhook = parseTypingIndicatorWebhook(req.body);
      const result = await conversationAgent.handleTyping(webhook);
      res.status(202).json(result);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : 'invalid payload' });
    }
  });

  app.post(
    SENDBLUE_WEBHOOK_TYPES.filter(
      type => type !== 'receive' && type !== 'outbound' && type !== 'typing_indicator'
    ).map(sendblueWebhookPath),
    async (req: Request, res: Response) => {
      await observeWebhook(req, deps.webhookObserver, logger);
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

  return {
    app,
    statusStore,
    conversationAgent,
    conversationStore,
    close: () => conversationAgent.close()
  };
}

async function observeWebhook(
  req: Request,
  observer: AppDependencies['webhookObserver'],
  logger: pino.Logger
): Promise<void> {
  if (!observer) return;

  try {
    await observer({
      headers: req.headers,
      body: req.body,
      rawBody: (req as RawBodyRequest).rawBody,
      receivedAt: new Date().toISOString(),
      path: req.path
    });
  } catch (error) {
    logger.warn({ err: error, path: req.path }, 'webhook observer failed');
  }
}
